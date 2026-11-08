//
//  PALSAssistantView.swift
//  PetBook
//
//  F4.2 PALS 跳转助手（二级 push 页，不挂 .ppShowsRootTabBar() → tab bar 自动隐藏）。
//  按某宠物的真实字段算出"申请前准备清单"（✓/✗），底部一键打开 PALS 官网。
//  POC（Pet Ownership Course）是 owner 级一次性资质（猫狗通用），清单对猫狗主都显示该项。
//  文案要点对齐 PRD F4.2 / §7.1 journey：标题区按物种 + 牌照状态给一句引导。
//

import SwiftUI

struct PALSAssistantView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.openURL) private var openURL

    // 实时读 store：只存 id + 兜底快照，正文一律通过计算属性 `pet` 取最新值。
    // 这样回填（store.updatePet）后，header / checklist / 回填区会随 @Observable 刷新自动更新。
    private let petID: UUID
    private let fallbackPet: Pet

    init(pet: Pet) {
        self.petID = pet.id
        self.fallbackPet = pet
    }

    /// 当前宠物最新状态：优先从 store 取（回填后即时反映），store 里找不到才退回 init 快照。
    private var pet: Pet { store.pet(id: petID) ?? fallbackPet }

    /// PALS 官网（AVS 宠物牌照在线申请系统）。
    private let palsURL = URL(string: "https://pals.avs.gov.sg")!

    // 回填区交互状态
    @State private var showLicenceSheet = false       // 「I've got my licence」新建 / 「Update expiry」编辑共用
    @State private var draftLicenceID = ""            // sheet 内输入的执照号
    @State private var draftExpiry: Date? = nil       // sheet 内选的到期日（可选）
    @State private var isEditingExpiryOnly = false    // true = 仅改到期日（已有执照号场景），隐藏执照号输入

    // checklist 就地回填交互状态
    @State private var showMicrochipAlert = false     // Microchipped 行 → 弹 alert（含 TextField）填芯片号
    @State private var draftMicrochip = ""            // alert 内输入的芯片号（点击时预填当前值）
    @State private var showPOCAlert = false           // POC 行 → 弹 alert 确认完成 / 撤销（owner 级，猫狗通用）

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PPSpacing.xl) {
                header
                checklistSection
                updateRecordsSection
                footerNote
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.sm)
            .padding(.bottom, PPSpacing.xxxl)
        }
        .background(Color.ppBackground)
        .navigationTitle("PALS Assistant")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            // 底部常驻行动按钮：打开 PALS 官网
            VStack(spacing: PPSpacing.xs) {
                PPPrimaryButton(title: "Open PALS", systemImage: "arrow.up.right") {
                    openURL(palsURL)
                }
                Text("Opens the official PALS website to submit your application.")
                    .font(.caption)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.md)
            .padding(.bottom, PPSpacing.lg)
        }
        .sheet(isPresented: $showLicenceSheet) {
            licenceSheet
        }
        // Microchip 行就地回填：alert 内含 TextField（iOS 16+）。预填当前芯片号，可改后保存。
        .alert("Microchip number", isPresented: $showMicrochipAlert) {
            TextField("e.g. 9000000123456", text: $draftMicrochip)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Save") { saveMicrochip() }
        } message: {
            Text("Enter \(pet.name)'s microchip number.")
        }
        // POC 行就地回填：未完成→确认完成；已完成→撤销。owner 级，猫狗主都显示该行。
        .alert(pocAlertTitle, isPresented: $showPOCAlert) {
            Button("Cancel", role: .cancel) {}
            Button(pocAlertConfirmTitle) { togglePOC() }
        } message: {
            Text(pocAlertMessage)
        }
    }

    // MARK: - 头部（按物种 + 牌照状态给引导）

    private var header: some View {
        HStack(spacing: PPSpacing.md) {
            PPPetAvatar(pet: pet, size: 56)
            VStack(alignment: .leading, spacing: PPSpacing.xs) {
                Text(headerTitle)
                    .font(.title3)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(headerSubtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    /// 是否已有牌照号
    private var hasLicence: Bool {
        !(pet.avsLicenseID?.isEmpty ?? true)
    }

    /// 牌照是否临近 / 已过期（≤30 天）
    private var licenceExpiringSoon: Bool {
        guard let exp = pet.avsLicenseExpiry else { return false }
        return HomeFeed.daysUntil(exp) <= 30
    }

    private var headerTitle: String {
        let name = pet.name
        if hasLicence {
            return licenceExpiringSoon
                ? "Renew \(name)'s \(licenceNoun) licence"
                : "\(name)'s \(licenceNoun) licence"
        }
        switch pet.species {
        case .cat: return "Apply for \(name)'s cat licence"
        case .dog: return "Register \(name)'s dog licence"
        }
    }

    private var headerSubtitle: String {
        if hasLicence {
            if licenceExpiringSoon {
                if let exp = pet.avsLicenseExpiry {
                    let d = HomeFeed.daysUntil(exp)
                    return d < 0
                        ? "Expired \(abs(d)) days ago — renew on PALS to stay compliant."
                        : "Expires in \(d) days — renew on PALS before it lapses."
                }
                return "Renew on PALS to stay compliant."
            }
            return "Your licence is active. Manage it anytime on PALS."
        }
        switch pet.species {
        case .cat: return "Cat licensing is open for HDB homes. Get ready, then apply on PALS."
        case .dog: return "Every dog in Singapore needs an AVS licence. Get ready, then apply on PALS."
        }
    }

    private var licenceNoun: String {
        pet.species == .cat ? "cat" : "dog"
    }

    // MARK: - 准备清单（读真实字段）

    private var checklistSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            Text("BEFORE YOU APPLY")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            VStack(spacing: 0) {
                ForEach(Array(checklistItems.enumerated()), id: \.offset) { idx, item in
                    checklistRow(item)
                    if idx < checklistItems.count - 1 {
                        Divider().padding(.leading, 52)
                    }
                }
            }
            .padding(PPSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .ppCard()
        }
    }

    /// 单项准备清单（标题 + 满足态 + 未满足时的补全提示 + 点击就地回填动作）
    private struct ChecklistItem {
        let title: LocalizedStringKey
        let isDone: Bool
        let unmetHint: LocalizedStringKey
        let action: () -> Void   // 整行点击触发的回填（弹 alert 等）
    }

    /// 按真实字段构建清单。POC 是 owner 级一次性资质，猫狗主都显示。每项整行可点击就地回填。
    private var checklistItems: [ChecklistItem] {
        var items: [ChecklistItem] = [
            .init(
                title: "Microchipped",
                isDone: !(pet.microchipID?.isEmpty ?? true),
                unmetHint: "Add \(pet.name)'s microchip number in their profile.",
                action: {
                    // 已有芯片号则预填到 TextField，可改后保存
                    draftMicrochip = pet.microchipID ?? ""
                    showMicrochipAlert = true
                }
            )
        ]

        // POC：owner 级一次性资质（PALS 申请前置，猫狗通用）—— 读写 owner.pocCompleted，不再看物种。
        items.append(
            .init(
                title: "Pet Ownership Course completed",
                isDone: store.owner.pocCompleted,
                unmetHint: "A one-time course for you as the owner — required before licensing any cat or dog",
                action: { showPOCAlert = true }   // 弹确认/撤销 alert
            )
        )

        // 注：疫苗记录不是申牌法定前置（AVS：法定前置仅 microchip，猫另加 POC；
        // 疫苗卡仅在申请绝育折扣时作为可选证明）。故不列入申请清单。
        return items
    }

    /// 单行：整行可点击就地回填。✓/✗ 图标维持原样，行尾加 chevron 提示可点。
    private func checklistRow(_ item: ChecklistItem) -> some View {
        Button(action: item.action) {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(item.isDone ? Color.ppSuccess : Color.ppTextSecondary)
                    .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if !item.isDone {
                        Text(item.unmetHint)
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextSecondary)
            }
            .padding(.vertical, PPSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - checklist 就地回填逻辑

    /// 保存芯片号：trim 后非空才写入（空输入忽略，不清掉已有值）。
    private func saveMicrochip() {
        let trimmed = draftMicrochip.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        var p = pet
        p.microchipID = trimmed
        store.updatePet(p)
    }

    /// 切换 owner 级 POC：未完成→完成（true）；已完成→撤销（false）。走 updateOwner 通道
    /// （mock 改本地 / network PATCH /v1/owner），完成后此人名下所有宠物的 POC 前置同步刷新。
    private func togglePOC() {
        let newValue = !store.owner.pocCompleted
        Task { await store.updateOwner { $0.pocCompleted = newValue } }
    }

    /// POC alert 文案：按 owner 当前完成态切「确认完成」/「撤销」两种语境（去 pet 化）。
    private var pocAlertTitle: String {
        store.owner.pocCompleted ? "Mark as not completed?" : "Pet Ownership Course"
    }

    private var pocAlertMessage: String {
        store.owner.pocCompleted
            ? "This will mark your Pet Ownership Course as not completed."
            : "Confirm you've completed the Pet Ownership Course?"
    }

    private var pocAlertConfirmTitle: String {
        store.owner.pocCompleted ? "Mark not done" : "Confirm"
    }

    // MARK: - 回填区（Already done? → 回写真实字段，对应首页待办自动消失）

    /// 是否已有牌照号（与 header 同源判定，避免重复）。
    private var hasLicenceID: Bool {
        !(pet.avsLicenseID?.isEmpty ?? true)
    }

    // 回填区永远恰好一行可用动作（无执照号→add details；有执照号→Update expiry），
    // 所以整块无条件渲染。POC 回填已上移到 BEFORE YOU APPLY 区。
    private var updateRecordsSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            Text("ALREADY DONE?")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            VStack(spacing: 0) {
                // 收集要显示的动作行，行间插分隔线（与 checklist 同款）
                let rows = updateRows
                ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                    row
                    if idx < rows.count - 1 {
                        Divider().padding(.leading, 52)
                    }
                }
            }
            .padding(PPSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .ppCard()
        }
    }

    /// 把"满足条件才显示"的回填行打包成数组，便于在卡片内插分隔线。
    /// 此区只保留"最后一步"——执照回填（POC 回填已上移到 BEFORE YOU APPLY，不在此重复）。
    private var updateRows: [AnyView] {
        var rows: [AnyView] = []

        if hasLicenceID {
            // 已有执照号：显示当前执照号 + 到期日 + 「Update expiry」
            rows.append(AnyView(licenceInfoRow))
        } else {
            // 无执照号：「I've got my licence — add details」
            rows.append(AnyView(addLicenceRow))
        }

        return rows
    }

    /// 行：尚无执照号 → 打开 sheet 新建（执照号 + 可选到期日）。
    private var addLicenceRow: some View {
        Button {
            // 新建模式：清空草稿，显示执照号输入
            draftLicenceID = ""
            draftExpiry = pet.avsLicenseExpiry
            isEditingExpiryOnly = false
            showLicenceSheet = true
        } label: {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: "seal")
                    .font(.title3)
                    .foregroundStyle(Color.ppPrimary)
                    .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text("I've got my licence — add details")
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Enter your AVS licence number to update your record.")
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextSecondary)
            }
            .padding(.vertical, PPSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 行：已有执照号 → 展示执照号 + 到期日，按钮打开 sheet 仅改到期日（续牌场景）。
    private var licenceInfoRow: some View {
        Button {
            // 编辑模式：带入现有到期日，只改 expiry
            draftLicenceID = pet.avsLicenseID ?? ""
            draftExpiry = pet.avsLicenseExpiry
            isEditingExpiryOnly = true
            showLicenceSheet = true
        } label: {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.title3)
                    .foregroundStyle(Color.ppSuccess)
                    .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Licence \(pet.avsLicenseID ?? "")")
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(licenceExpiryText)
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                Text("Update expiry")
                    .font(.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppPrimary)
            }
            .padding(.vertical, PPSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 执照行副文案：有到期日就显示日期，没有就提示补一个。
    private var licenceExpiryText: String {
        if let exp = pet.avsLicenseExpiry {
            let d = HomeFeed.daysUntil(exp)
            let dateStr = exp.formatted(.dateTime.day().month(.wide).year())
            if d < 0 { return "Expired \(abs(d)) days ago · \(dateStr)" }
            return "Expires \(dateStr)"
        }
        return "No expiry date on file — tap to add one."
    }

    // MARK: - License 回填 sheet（新建执照 / 续牌改到期日共用）

    private var licenceSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PPSpacing.xl) {
                    // 仅"新建执照号"时显示输入框；续牌（仅改到期日）时隐藏
                    if !isEditingExpiryOnly {
                        VStack(alignment: .leading, spacing: PPSpacing.xs) {
                            Text("AVS licence number")
                                .font(.caption)
                                .foregroundStyle(Color.ppTextSecondary)

                            TextField("As shown on your AVS licence", text: $draftLicenceID)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .font(.body)
                                .padding(.horizontal, PPSpacing.md)
                                .padding(.vertical, 12)
                                .background(
                                    RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                                        .fill(Color.ppSurface)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                                        .strokeBorder(Color.ppBorder, lineWidth: 1)
                                )
                        }
                    }

                    // 到期日 — graphical 日历，沿用 AddPetSection 的 license expiry 写法（可选未来日期）
                    VStack(alignment: .leading, spacing: PPSpacing.xs) {
                        Text("Licence expiry")
                            .font(.caption)
                            .foregroundStyle(Color.ppTextSecondary)

                        DatePicker(
                            "Licence expiry",
                            selection: Binding(
                                get: { draftExpiry ?? (Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date()) },
                                set: { draftExpiry = $0 }
                            ),
                            displayedComponents: .date
                        )
                        .datePickerStyle(.graphical)
                        .tint(Color.ppPrimary)
                        .labelsHidden()
                    }
                }
                .padding(.horizontal, PPSpacing.xl)
                .padding(.top, PPSpacing.lg)
                .padding(.bottom, PPSpacing.xxxl)
            }
            .background(Color.ppBackground)
            .navigationTitle(isEditingExpiryOnly ? "Update expiry" : "Add licence")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { showLicenceSheet = false }
                        .foregroundStyle(Color.ppTextSecondary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { saveLicence() }
                        .fontWeight(.semibold)
                        .foregroundStyle(canSaveLicence ? Color.ppPrimary : Color.ppTextSecondary)
                        .disabled(!canSaveLicence)
                }
            }
        }
        .presentationDetents([.large])
    }

    /// 新建模式必须填执照号；续牌模式只改到期日（始终可保存）。
    private var canSaveLicence: Bool {
        isEditingExpiryOnly || !draftLicenceID.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// 把草稿回写到 store；执照号变更触发 applyCatLicence / registerDogLicence 待办消失，
    /// 到期日推到 >30 天后则 renewLicence 待办消失。
    private func saveLicence() {
        var p = pet
        if !isEditingExpiryOnly {
            p.avsLicenseID = draftLicenceID.trimmingCharacters(in: .whitespaces)
        }
        p.avsLicenseExpiry = draftExpiry
        store.updatePet(p)
        showLicenceSheet = false
    }

    // MARK: - 底部说明

    private var footerNote: some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(systemName: "info.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.ppPrimary)
            Text("PetBook doesn't submit applications. We help you get ready — licensing is done on the official PALS website.")
                .font(.footnote)
                .foregroundStyle(Color.ppTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(PPSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                .fill(Color.ppPrimary.opacity(0.06))
        )
    }
}

#Preview("Dog — not registered") {
    NavigationStack {
        PALSAssistantView(pet: Pet.mocks[1])   // Buddy（狗）
    }
    .environment(PetBookStore())
}

#Preview("Cat") {
    NavigationStack {
        PALSAssistantView(pet: Pet.mocks[0])   // Mochi（猫）
    }
    .environment(PetBookStore())
}
