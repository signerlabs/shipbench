//
//  PetDetailView.swift
//  PetBook
//
//  单只宠物档案详情（二级页面，从 Home 头像横条 push）。
//  整页用原生 Form 分 section（参考另一个 App 的 Form 模式）：
//    Hero / Weight = 特殊行（listRowBackground(.clear) 去背景，保留自带视觉）；
//    Vaccinations / Deworming / Other info = 白卡 section（listRowBackground(ppSurface)）。
//  健康两段每行原生左滑（Edit / Delete）+ 点击进编辑页。
//  .scrollContentBackground(.hidden) 去掉 Form 系统灰底，换 ppBackground。
//  二级页面不挂 .ppShowsRootTabBar()（tab bar 自动隐藏）。
//

import PhotosUI
import SwiftUI
import Charts   // SWLineChart 的 interpolationMethod: .catmullRom 来自 Charts（系统框架，iOS 16+，非第三方依赖）

// MARK: - 格式化辅助（列表 + 详情共用）

enum PetFormat {
    /// 从出生日期算年龄字符串：≥1 岁显 "Xy"（保留半岁如 "1.5y"），<1 岁显 "Xmo"。
    static func ageString(from dob: Date?) -> String? {
        guard let dob else { return nil }
        let now = Date()
        guard dob <= now else { return nil }
        let months = Calendar.current.dateComponents([.month], from: dob, to: now).month ?? 0
        if months < 12 {
            return "\(max(months, 0))mo"
        }
        // 以半岁为粒度（1.0 / 1.5 / 2.0 ...），整岁去掉小数点
        let halfYears = (Double(months) / 6.0).rounded() / 2.0
        if halfYears == halfYears.rounded() {
            return "\(Int(halfYears))y"
        }
        return "\(halfYears)y"
    }

    /// 中等样式日期（如 "May 28, 2026"），nil 显 "—"
    static func mediumDate(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(.dateTime.year().month(.abbreviated).day())
    }
}

// MARK: - 详情主体

struct PetDetailView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // 实时读 store（与 PALSAssistantView 同款）：保留 init(pet:) 快照作 fallback，
    // 实际渲染始终走 store.pet(id:)，编辑 overview 后详情页自动刷新。
    private let petID: UUID
    private let fallbackPet: Pet

    init(pet: Pet) {
        self.petID = pet.id
        self.fallbackPet = pet
    }

    /// 实时宠物档案：优先取 store 最新值，store 内查不到（如纯 preview）退回 init 快照。
    private var pet: Pet { store.pet(id: petID) ?? fallbackPet }

    @State private var showAddVaccine = false
    @State private var showAddDeworming = false
    @State private var showAddWeight = false
    @State private var showEditOverview = false

    // 健康记录折叠态：默认只显最近 3 条，> 3 条时底部控件切换展开/收起。各段各自独立。
    @State private var expandVaccinations = false
    @State private var expandDewormings = false

    // 点击行 / 左滑 Edit：选中的记录（非 nil 时弹编辑 sheet，复用 Add sheet 的 existing 模式）
    @State private var editingVaccine: VaccinationRecord?
    @State private var editingDeworming: DewormingRecord?

    // 删除宠物确认 alert（不可逆：连带删除全部健康记录）
    @State private var showDeleteConfirm = false

    // 换头像：hero 大卡点击即换（与 Home「点背景换背景」同构；EditOverviewSheet 的深层入口保留）
    @State private var showPhotoPicker = false
    @State private var photoItem: PhotosPickerItem?

    /// 折叠时默认显示的最大条数。
    private let collapsedLimit = 3

    var body: some View {
        Form {
            hero
            weightSection
            vaccinationSection
            dewormingSection
            otherInfoSection
            deleteSection
        }
        .scrollContentBackground(.hidden)
        .background(Color.ppBackground)
        .scrollIndicators(.hidden)
        .navigationTitle(pet.name)
        .navigationBarTitleDisplayMode(.inline)
        .alert("Delete \(pet.name)?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) {
                store.removePet(id: pet.id)
                dismiss()   // pop 回 Home（当前页失效由 HomeView onChange 回落到第一只）
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes \(pet.name)'s profile and all health records. This can't be undone.")
        }
        .sheet(isPresented: $showAddVaccine) {
            AddVaccinationSheet(petID: pet.id)
        }
        .sheet(isPresented: $showAddDeworming) {
            AddDewormingSheet(petID: pet.id)
        }
        .sheet(isPresented: $showAddWeight) {
            AddWeightSheet(petID: pet.id)
        }
        .sheet(isPresented: $showEditOverview) {
            EditOverviewSheet(pet: pet)
        }
        .sheet(item: $editingVaccine) { record in
            AddVaccinationSheet(petID: pet.id, existing: record)
        }
        .sheet(item: $editingDeworming) { record in
            AddDewormingSheet(petID: pet.id, existing: record)
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            handlePhotoSelection(item)
        }
        // 进详情页按 pet 懒加载健康记录（network 模式拉后端，mock 模式 no-op）。
        .task(id: petID) {
            await store.loadHealthRecords(petID: petID)
        }
    }

    // MARK: Hero

    /// 可 3D 立体转动的宠物卡片（1:1 正方形）：宠物图片填满，name + 副标题 overlay 在底部，拖拽可倾斜旋转。
    /// 点击 = 换头像。⚠️ 必须用 simultaneousGesture 挂 tap：卡片内部的 3D 拖拽是
    /// DragGesture(minimumDistance: 0)，手指一落即被子视图识别，普通 .onTapGesture（父级默认互斥）
    /// 会被击败、点击无反应；simultaneous 声明后两者并行识别——轻点弹 picker，拖拽照常把玩卡片。
    private var hero: some View {
        Section {
            PetHeroCard(pet: pet, subtitle: heroSubtitle)
                .simultaneousGesture(
                    TapGesture().onEnded {
                        showPhotoPicker = true
                    }
                )
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: PPSpacing.xxl,
                                  leading: PPSpacing.xxl,
                                  bottom: PPSpacing.xxl,
                                  trailing: PPSpacing.xxl))
        .listRowSeparator(.hidden)
    }

    /// 选图 → JPEG → 上传换头像（照 ProfileCompletionFlow.handlePhotoSelection 链路：
    /// network 走 store.replacePhoto，photoVersion 自增驱动 hero / 头像刷新；mock / 失败降级本地缓存）。
    private func handlePhotoSelection(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let rawData = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: rawData),
                  let jpegData = image.jpegData(compressionQuality: 0.85) else {
                SWAlertManager.shared.show(.error, message: "Failed to load photo")
                return
            }
            do {
                try await store.replacePhoto(petID: pet.id, jpegData: jpegData)
                SWAlertManager.shared.show(.success, message: "Photo updated")
            } catch {
                ImageCache.shared.store(image, forKey: "local/\(pet.id)/photo")
                var updated = pet
                updated.photoAssetName = "local/\(pet.id)/photo"
                store.updatePet(updated)
                SWAlertManager.shared.show(.success, message: "Photo updated")
            }
        }
    }

    /// "物种 · 品种 · 年龄"
    private var heroSubtitle: String {
        var parts: [String] = [pet.species.displayName]
        if let breed = pet.breed, !breed.isEmpty { parts.append(breed) }
        if let age = PetFormat.ageString(from: pet.dob) { parts.append(age) }
        return parts.joined(separator: " · ")
    }

    // MARK: Weight — 当前体重数值 + ≥2 条趋势图

    private var weightSection: some View {
        let records = store.weights(of: pet.id)   // 已按日期升序
        return Section {
            if records.isEmpty {
                emptyHint("No weight records yet")
            } else {
                VStack(alignment: .leading, spacing: PPSpacing.sm) {
                    HStack(alignment: .firstTextBaseline, spacing: PPSpacing.xs) {
                        Text(records.last!.weightKg.formatted(.number.precision(.fractionLength(0...1))))
                            .font(.title2)
                            .fontWeight(.bold)
                            .fontDesign(.rounded)
                            .foregroundStyle(Color.ppTextPrimary)
                        Text("kg")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                        Spacer()
                        Text("\(records.count) record\(records.count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(Color.ppTextSecondary)
                    }

                    // ≥2 条画趋势折线（WeightChart：自适应日期范围 + 双指缩放 + 单指拖拽滚动）
                    if records.count >= 2 {
                        WeightChart(records: records)
                    }
                }
                .padding(.vertical, PPSpacing.xs)
            }
        } header: {
            sectionHeader("Weight", systemImage: "plus", label: "Add") { showAddWeight = true }
        }
        .listRowBackground(Color.ppSurface)
    }

    // MARK: Vaccinations — 每行左滑 Edit/Delete + 点击编辑

    private var vaccinationSection: some View {
        // 按接种日期降序（最新在最上）
        let records = store.vaccinations(of: pet.id)
            .sorted { $0.administeredDate > $1.administeredDate }
        let visible = expandVaccinations ? records : Array(records.prefix(collapsedLimit))
        return Section {
            if records.isEmpty {
                emptyHint("No vaccination records yet")
            } else {
                ForEach(visible) { record in
                    VaccinationRow(record: record)
                        .contentShape(Rectangle())
                        .onTapGesture { editingVaccine = record }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                store.deleteVaccination(record)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                editingVaccine = record
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .tint(Color.ppPrimary)
                        }
                }
                if records.count > collapsedLimit {
                    expandToggle(isExpanded: $expandVaccinations, totalCount: records.count)
                }
            }
        } header: {
            sectionHeader("Vaccinations", systemImage: "plus", label: "Add") { showAddVaccine = true }
        }
        .listRowBackground(Color.ppSurface)
    }

    // MARK: Deworming — 同疫苗段

    private var dewormingSection: some View {
        let records = store.dewormings(of: pet.id)
            .sorted { $0.administeredDate > $1.administeredDate }
        let visible = expandDewormings ? records : Array(records.prefix(collapsedLimit))
        return Section {
            if records.isEmpty {
                emptyHint("No deworming records yet")
            } else {
                ForEach(visible) { record in
                    DewormingRow(record: record)
                        .contentShape(Rectangle())
                        .onTapGesture { editingDeworming = record }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                store.deleteDeworming(record)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                editingDeworming = record
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .tint(Color.ppPrimary)
                        }
                }
                if records.count > collapsedLimit {
                    expandToggle(isExpanded: $expandDewormings, totalCount: records.count)
                }
            }
        } header: {
            sectionHeader("Deworming", systemImage: "plus", label: "Add") { showAddDeworming = true }
        }
        .listRowBackground(Color.ppSurface)
    }

    // MARK: Other info — 基本档案字段（低频，沉到最后）

    private var otherInfoSection: some View {
        Section {
            detailRow("Sex", pet.sex.displayName)
            detailRow("Microchip ID", pet.microchipID ?? "—")
            detailRow("Sterilized", sterilizedText)
            detailRow("Licence no.", pet.avsLicenseID ?? "—")
            detailRow("Licence expiry", PetFormat.mediumDate(pet.avsLicenseExpiry))
        } header: {
            sectionHeader("Other info", systemImage: "square.and.pencil", label: "Edit") { showEditOverview = true }
        }
        .listRowBackground(Color.ppSurface)
    }

    // MARK: Delete — 删除宠物（沉底最后一段，destructive 红字 + 原生 alert 二次确认）

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) {
                showDeleteConfirm = true
            } label: {
                Text("Delete \(pet.name)")
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity)
            }
        }
        .listRowBackground(Color.ppSurface)
    }

    // MARK: - 小组件

    /// sterilized 三态：true / false / nil(Don't know)
    private var sterilizedText: String {
        switch pet.sterilized {
        case .some(true):  "Yes"
        case .some(false): "No"
        case .none:        "Don't know"
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(Color.ppTextSecondary)
            Spacer(minLength: PPSpacing.md)
            Text(value)
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundStyle(value == "—" ? Color.ppTextSecondary : Color.ppTextPrimary)
                .multilineTextAlignment(.trailing)
        }
    }

    private func emptyHint(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Color.ppTextSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 段头：大写标题 + 右侧动作按钮（Add / Edit）。`.textCase(nil)` 防 Form 二次大写按钮文案。
    private func sectionHeader(_ title: String, systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        HStack {
            Text(title.uppercased())
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)
            Spacer()
            Button(action: action) {
                HStack(spacing: PPSpacing.xs) {
                    Image(systemName: systemImage)
                        .font(.system(size: 12, weight: .semibold))
                    Text(label)
                        .font(.footnote)
                        .fontWeight(.semibold)
                }
                .foregroundStyle(Color.ppPrimary)
            }
            .buttonStyle(.plain)
        }
        .textCase(nil)
    }

    /// 健康记录段底部的「展开全部 ↔ 收起」控件（仅记录数 > collapsedLimit 时出现）。
    private func expandToggle(isExpanded: Binding<Bool>, totalCount: Int) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.25)) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: PPSpacing.xs) {
                Text(isExpanded.wrappedValue ? "Show less" : "Show all (\(totalCount))")
                    .font(.footnote)
                    .fontWeight(.semibold)
                Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(Color.ppPrimary)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 疫苗记录行

private struct VaccinationRow: View {
    let record: VaccinationRecord

    var body: some View {
        HStack(spacing: PPSpacing.md) {
            Image(systemName: "syringe")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.ppPrimary)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.ppPrimary.opacity(0.1)))

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PPSpacing.xs) {
                    Text(record.vaccineType.rawValue)
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                    if let brand = record.brand, !brand.isEmpty {
                        Text("· \(brand)")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                            .lineLimit(1)
                    }
                }
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
            }

            Spacer(minLength: 0)
        }
    }

    private var subtitle: String {
        var s = PetFormat.mediumDate(record.administeredDate)
        if let next = record.nextDueDate {
            s += "  ·  next: \(PetFormat.mediumDate(next))"
        }
        return s
    }
}

// MARK: - 驱虫记录行（照 VaccinationRow 模式）

private struct DewormingRow: View {
    let record: DewormingRecord

    var body: some View {
        HStack(spacing: PPSpacing.md) {
            Image(systemName: "pills")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.ppPrimary)
                .frame(width: 36, height: 36)
                .background(Circle().fill(Color.ppPrimary.opacity(0.1)))

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PPSpacing.xs) {
                    Text(record.kind.displayName)
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                    if let product = record.productName, !product.isEmpty {
                        Text("· \(product)")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                            .lineLimit(1)
                    }
                }
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
            }

            Spacer(minLength: 0)
        }
    }

    private var subtitle: String {
        var s = PetFormat.mediumDate(record.administeredDate)
        if let next = record.nextDueDate {
            s += "  ·  next: \(PetFormat.mediumDate(next))"
        }
        return s
    }
}

// MARK: - 体重折线图（Swift Charts：X 轴自适应记录日期范围 + 双指缩放 + 单指拖拽滚动）

private struct WeightChart: View {
    let records: [WeightRecord]   // 升序

    /// 可见窗口天数：自适应覆盖记录范围 + 一成留白，封顶 120 天。
    private var visibleDays: Double {
        guard let first = records.first?.recordedDate,
              let last = records.last?.recordedDate else { return 7 }
        let d = Double(Calendar.current.dateComponents([.day], from: first, to: last).day ?? 0)
        return min(max(d * 1.1, 7), 120)
    }

    var body: some View {
        Chart(records) { r in
            LineMark(
                x: .value("Date", r.recordedDate),
                y: .value("kg", r.weightKg)
            )
            .foregroundStyle(Color.ppPrimary)
            .interpolationMethod(.catmullRom)
            .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))

            PointMark(
                x: .value("Date", r.recordedDate),
                y: .value("kg", r.weightKg)
            )
            .foregroundStyle(Color.ppPrimary)
            .symbolSize(28)
        }
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: Int(visibleDays * 86_400))
        .chartScrollPosition(initialX: records.last?.recordedDate ?? Date())
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisValueLabel()
            }
        }
        .frame(height: 160)
    }
}

#Preview {
    NavigationStack { PetDetailView(pet: Pet.mocks[1]) }   // Buddy（狗，记录较全）
        .environment(PetBookStore())
        .environment(PetBookTabBarController())
        .environment(LocationManager())
}
