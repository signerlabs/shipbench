//
//  EditOverviewSheet.swift
//  PetBook
//
//  PetDetailView 的 Overview section 编辑 sheet：编辑宠物档案 7 个字段
//  （Breed / Sex / DOB / Microchip / Sterilized / Licence no. / Licence expiry）。
//  体重不在此编辑——已收敛到 WeightRecord（一处真相），改体重走 Weight section 加记录。
//  风格与 AddVaccinationSheet / AddWeightSheet 一致：NavigationStack + ScrollView
//  + Cancel 工具栏 + 底部 PPPrimaryButton "Save"。
//
//  - Breed 复用 PPSearchablePicker（按 species 猫狗分流，狗行尾挂 HDB 合规徽章）。
//  - DOB / Licence expiry 用折叠白卡触发器 + graphical 日历 sheet（与 AddPetSection 同款）。
//  - Sterilized 三态 chips（Yes / No / Don't know，nil = Don't know）。
//
//  保存：把各 draft 写回 pet 副本（空文本 trim → nil），
//  store.updatePet → dismiss → toast。详情页实时读 store，保存后自动刷新。
//

import SwiftUI
import PhotosUI

struct EditOverviewSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private let pet: Pet

    // MARK: Draft 状态（初值取传入 pet）

    @State private var name: String
    @State private var breed: String
    @State private var sex: PetSex
    @State private var dob: Date?
    @State private var microchip: String
    /// 三态：true / false / nil（Don't know）
    @State private var sterilized: Bool?
    @State private var avsLicense: String
    @State private var avsLicenseExpiry: Date?

    // 更改头像
    @State private var photoItem: PhotosPickerItem?
    @State private var avatarPreview: Image?   // 选中新图后的本地预览（覆盖在当前头像之上）
    @State private var isUploadingPhoto = false

    init(pet: Pet) {
        self.pet = pet
        _name = State(initialValue: pet.name)
        _breed = State(initialValue: pet.breed ?? "")
        _sex = State(initialValue: pet.sex)
        _dob = State(initialValue: pet.dob)
        _microchip = State(initialValue: pet.microchipID ?? "")
        _sterilized = State(initialValue: pet.sterilized)
        _avsLicense = State(initialValue: pet.avsLicenseID ?? "")
        _avsLicenseExpiry = State(initialValue: pet.avsLicenseExpiry)
    }

    private var isDog: Bool { pet.species == .dog }

    /// name 是必填——trim 后非空才可保存（不让用户把名字清空）。
    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                // 头像 — 特殊 section：居中、去背景
                Section {
                    photoSection
                }
                .listRowBackground(Color.clear)

                // 基本信息
                Section {
                    LabeledContent("Name") {
                        TextField("Name", text: $name)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }

                    // Sex — 原生 Picker
                    Picker("Sex", selection: $sex) {
                        ForEach(PetSex.allCases) { s in
                            Text(s.displayName).tag(s)
                        }
                    }

                    DatePicker("Date of birth",
                               selection: Binding(get: { dob ?? Date() }, set: { dob = $0 }),
                               in: ...Date(),
                               displayedComponents: .date)

                }
                .listRowBackground(Color.ppSurface)

                Section {
                    // Breed — 复用 onboarding 的 searchable picker（带搜索 + 狗品种 HDB 徽章）
                    LabeledContent("Breed") {
                        PPSearchablePicker(
                            placeholder: "Select breed",
                            sheetTitle: isDog ? "Select Dog Breed" : "Select Cat Breed",
                            searchPrompt: "Search breeds",
                            selection: $breed,
                            options: isDog ? BreedCatalog.dogBreedNames : BreedCatalog.catBreeds
                        ) { name in
                            if isDog, let status = BreedCatalog.dogStatus(for: name) {
                                HDBComplianceBadge(status: status)
                            }
                        }
                    }
                } header: {
                    if isDog {
                        Text("For the HDB compliance check")
                    }
                }
                .listRowBackground(Color.ppSurface)

                // 绝育 + 牌照（绝育状态决定是否要到期日）
                Section {
                    LabeledContent("Microchip ID") {
                        TextField("15 digits", text: $microchip)
                            .keyboardType(.numberPad)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }

                    // Sterilized — 原生 Picker（三态，含 Don't know）
                    Picker("Sterilized?", selection: $sterilized) {
                        Text("Yes").tag(true as Bool?)
                        Text("No").tag(false as Bool?)
                        Text("Don't know").tag(Bool?.none)
                    }

                    // 绝育 → 终身牌：无需续期
                    if sterilized == true {
                        licenceNote(
                            icon: "checkmark.seal.fill",
                            tint: Color.ppSuccess,
                            text: "Sterilised pets qualify for a lifetime AVS licence — no renewal needed."
                        )
                    }

                    LabeledContent("Licence number") {
                        TextField("", text: $avsLicense)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                    }

                    // 周期牌（未绝育 / 不确定）+ 已填牌照号 → 到期日 + 续期提醒说明
                    if sterilized != true, !avsLicense.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        DatePicker("Licence expiry",
                                   selection: Binding(get: { avsLicenseExpiry ?? Date() }, set: { avsLicenseExpiry = $0 }),
                                   displayedComponents: .date)
                        licenceNote(
                            icon: "bell.badge.fill",
                            tint: Color.ppPrimary,
                            text: "Periodic licence — we'll remind you before it expires."
                        )
                    }
                } footer: {
                    Text("Sterilization decides the licence type — sterilised pets get a lifetime AVS licence; others need periodic renewal.")
                }
                .listRowBackground(Color.ppSurface)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollContentBackground(.hidden)
            .background(Color.ppBackground)
            .navigationTitle("Edit profile")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                PPPrimaryButton(title: "Save", enabled: canSave) {
                    save()
                }
                .shadow(radius: 10)
                .padding(.horizontal, PPSpacing.xxxl)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                        .tint(Color.ppTextSecondary)
                }
            }
            .onChange(of: photoItem) { _, newItem in
                Task { await handlePhotoPick(newItem) }
            }
            .scrollIndicators(.hidden)
            .presentationDragIndicator(.visible)
        }
    }

    // MARK: - 更改 / 补充头像

    /// 头像区：当前头像（或刚选的新图预览）+ Change photo 入口 + 上传中转圈。
    @ViewBuilder
    private var photoSection: some View {
        VStack(spacing: PPSpacing.sm) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                ZStack {
                    if let avatarPreview {
                        // 刚选中的新图本地预览（圆形显示层裁切，与存储原图比例无关）
                        avatarPreview
                            .resizable()
                            .scaledToFill()
                            .frame(width: 96, height: 96)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Color.ppBorder, lineWidth: 1))
                    } else {
                        // 当前头像（远程照片 / mock Asset / emoji 兜底，复用 PPPetAvatar 全部逻辑）
                        PPPetAvatar(pet: pet, size: 96)
                    }

                    // 右下角相机角标
                    Image(systemName: "camera.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(Circle().fill(Color.ppPrimary))
                        .overlay(Circle().strokeBorder(Color.ppBackground, lineWidth: 2))
                        .offset(x: 34, y: 34)

                    // 上传中：半透明遮罩 + 转圈
                    if isUploadingPhoto {
                        Circle()
                            .fill(.black.opacity(0.35))
                            .frame(width: 96, height: 96)
                        ProgressView()
                            .tint(.white)
                    }
                }
                .frame(width: 96, height: 96)
            }
            .buttonStyle(.plain)
            .disabled(isUploadingPhoto)

            Text("Change photo")
                .font(.footnote)
                .foregroundStyle(Color.ppPrimary)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, PPSpacing.sm)
    }

    /// 选图后：加载 → 等比缩放（≤1600，只缩不裁）→ JPEG 0.8 → 上传覆盖 → 本地预览。
    /// 失败大声暴露（mock 模式 / 网络错误都走这里），不静默吞。
    private func handlePhotoPick(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let uiImage = UIImage(data: data),
              let jpeg = uiImage.downscaled(maxDimension: 1600).jpegData(compressionQuality: 0.8) else {
            SWAlertManager.shared.show(.error, message: "Couldn't read that photo")
            return
        }

        isUploadingPhoto = true
        defer { isUploadingPhoto = false }

        do {
            try await store.replacePhoto(petID: pet.id, jpegData: jpeg)
            avatarPreview = Image(uiImage: uiImage)   // 上传成功 → 本屏即时预览
            SWAlertManager.shared.show(.success, message: "Photo updated")
        } catch {
            SWAlertManager.shared.show(.error, message: "Failed to update photo: \(error.localizedDescription)")
        }
    }

    // MARK: - 牌照类型说明行

    /// 终身牌免续 / 周期牌提醒说明：浅色卡片 + SF Symbol + 文案，教育用户两类牌照差异。
    @ViewBuilder
    private func licenceNote(icon: String, tint: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: PPSpacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
            Text(text)
                .font(.footnote)
                .foregroundStyle(Color.ppTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(PPSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                .fill(tint.opacity(0.1))
        )
    }

    // MARK: - 保存

    private func save() {
        var p = pet

        // name 必填（canSave 已保证非空）：trim 后写回
        p.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // 空文本 trim 后映射 nil
        p.breed = trimmedOrNil(breed)
        p.sex = sex
        p.dob = dob
        p.microchipID = trimmedOrNil(microchip)
        p.sterilized = sterilized
        p.avsLicenseID = trimmedOrNil(avsLicense)
        // 绝育持终身牌、无到期日；牌照号空也无到期日 → 强制清除，杜绝"绝育却有到期日"的矛盾数据
        p.avsLicenseExpiry = (sterilized == true || trimmedOrNil(avsLicense) == nil) ? nil : avsLicenseExpiry

        store.updatePet(p)
        dismiss()
        SWAlertManager.shared.show(.success, message: "Profile updated")
    }

    /// trim 后空串 → nil，否则保留 trim 结果。
    private func trimmedOrNil(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

}

#Preview("Dog") {
    EditOverviewSheet(pet: Pet.mocks[1])   // Buddy（狗，档案较全）
        .environment(PetBookStore())
}

#Preview("Cat") {
    EditOverviewSheet(pet: Pet.mocks[0])   // Mochi（猫）
        .environment(PetBookStore())
}
