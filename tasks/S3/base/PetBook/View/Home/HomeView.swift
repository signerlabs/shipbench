//
//  HomeView.swift
//  PetBook
//
//  Home tab —— 每只宠物一页的沉浸式主场（设计语言 v2 · P6）。
//  横向 TabView(.page) 左右滑切换宠物，末页 = 添加宠物；每页顶部是全幅背景图。
//  背景图与头像是分离的独立资产（类似小红书头像/背景图，都可为空）：
//  pets.background_path（POST /v1/pets/:id/background 上传落库）→ 空 = 空状态背景
//  （PPMeshBackground 品牌渐变 + 物种 emoji 浮印，深色字）；有图 = 图底黑渐变保白字。
//  hero 区 = 头像 + 名字 + 副标题（点击 push PetDetailView）+ 换背景入口（PhotosPicker）。
//  内容区 = 该宠物的 Profile Completion 卡 / Next Steps / UPCOMING 时间线 / HDB 快检。
//  （店铺预约横向卡片 HomeAppointmentStrip 属阶段二预约能力，阶段一隐藏，代码留存；PRD §4.0。）
//

import PhotosUI
import SwiftUI

/// 合规模块 push 目标（NextStep 卡 + 合规快检卡共用）。
/// 用 .navigationDestination(item:) 统一驱动，把"可 push"与"仅 toast"分流。
enum ComplianceDestination: Hashable {
    case hdbChecker(pet: Pet)   // → HDBComplianceCheckerView
    case pals(pet: Pet)         // → PALSAssistantView
    case poc                    // → POCCourseView（owner 级 Pet Ownership Course 详情页，与具体宠物无关）
}

struct HomeView: View {
    @Environment(PetBookStore.self) private var store

    @Environment(\.scenePhase) private var scenePhase
    @State private var complianceDestination: ComplianceDestination?
    @State private var notificationAuthorized = false
    @State private var profileCompletionPet: Pet?
    @State private var completingPetID: UUID?
    @State private var showConfetti = false

    /// 分页标识：一只宠物一页 + 末页添加宠物。
    enum HomePage: Hashable {
        case pet(UUID)
        case add
    }

    /// 当前页（nil = 首次出现尚未初始化，onAppear 落到第一只宠物）。
    @State private var selectedPage: HomePage?

    /// AddPetFlow 的呈现收在 HomeView 层（稳定宿主）：挂在 TabView 子页 / 空状态视图上时，
    /// submit 建宠 → pets 变化 → 宿主重建 → cover 被 SwiftUI 连带拆除，庆祝屏断档。
    @State private var showAddPet = false

    var body: some View {
        Group {
            if store.pets.isEmpty {
                HomeEmptyState(onAdd: { showAddPet = true })
            } else {
                pager
            }
        }
        .background(Color.ppBackground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        // 沉浸到顶的必要条件：隐藏 nav bar 的 scroll-edge 白底材质，背景图才能透出状态栏区域
        .toolbarBackground(.hidden, for: .navigationBar)
        .ppBellToolbar(prominent: true)
        .ppShowsRootTabBar()
        // 合规模块统一 push 出口（NextStep 卡 + 合规快检卡共用）
        .navigationDestination(item: $complianceDestination) { destination in
            switch destination {
            case .hdbChecker(let pet):
                HDBComplianceCheckerView(pet: pet)
            case .pals(let pet):
                PALSAssistantView(pet: pet)
            case .poc:
                POCCourseView()
            }
        }
        .fullScreenCover(item: $profileCompletionPet, onDismiss: {
            guard let petID = completingPetID,
                  let pet = store.pets.first(where: { $0.id == petID }),
                  ProfileCompletionFeed.pendingSteps(for: pet, store: store, notificationAuthorized: notificationAuthorized).isEmpty
            else { return }
            showConfetti = true
        }) { pet in
            ProfileCompletionFlow(
                petID: pet.id,
                onNotificationChanged: { notificationAuthorized = $0 }
            )
        }
        .swConfetti(isActive: $showConfetti, particleCount: 60, spread: .narrow, autoReset: true, centerOrigin: true)
        .fullScreenCover(isPresented: $showAddPet) {
            AddPetFlow()
        }
        .task {
            notificationAuthorized = await ProfileCompletionFeed.checkNotificationAuthorization()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { notificationAuthorized = await ProfileCompletionFeed.checkNotificationAuthorization() }
            }
        }
    }

    // MARK: - 分页容器（一只宠物一页 + 末页添加宠物）

    private var pager: some View {
        TabView(selection: $selectedPage) {
            ForEach(store.pets) { pet in
                HomePetPage(
                    pet: pet,
                    notificationAuthorized: notificationAuthorized,
                    onCompliance: { complianceDestination = $0 },
                    onStartCompletion: {
                        completingPetID = pet.id
                        profileCompletionPet = pet
                    }
                )
                .tag(Optional(HomePage.pet(pet.id)))
            }

            AddPetPage(onAdd: { showAddPet = true })
                .tag(Optional(HomePage.add))
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        // 沉浸背景挂 TabView 外层（另一个项目的做法）：背景不参与分页布局，
        // 翻页时 UIPageViewController 重解析子页 safe area 也影响不到它，顶部永不露白；
        // 页落定后按当前页 crossfade 换图（滑动中保持旧图，与参考页同手感）。
        .background {
            HomePetBackdrop(pet: currentPagePet, height: homeBackdropHeight)
                .id(backdropID)
                .transition(.opacity)
                .animation(.easeInOut, value: backdropID)
        }
        // 自定义 page dots（系统 indexDisplay 会压在浮层 tab bar 上，改用 PPPageDots 提到 tab bar 上方）
        .overlay(alignment: .bottom) {
            PPPageDots(currentIndex: dotIndex, total: store.pets.count + 1)
                .padding(.bottom, 65)   // 浮层 tab bar 上方
        }
        .onAppear {
            if selectedPage == nil, let first = store.pets.first {
                selectedPage = .pet(first.id)
            }
        }
        .onChange(of: store.pets.map(\.id)) { oldIDs, ids in
            // 删宠 / 账号切换后当前页失效 → 回落到第一只
            if case .pet(let id) = selectedPage, !ids.contains(id) {
                selectedPage = ids.first.map { .pet($0) }
            }
            // 新增宠物（add 页走完 AddPetFlow）→ 静默切到新宠物页：
            // 庆祝屏 dismiss 后用户正好落在新宠物的主场，而不是还停在 add 页
            if selectedPage == .add || selectedPage == nil,
               let newID = ids.first(where: { !oldIDs.contains($0) }) {
                selectedPage = .pet(newID)
            }
        }
    }

    /// 当前页对应的宠物（add 页 / 未初始化 → nil，背景层显示通用 mesh）。
    private var currentPagePet: Pet? {
        if case .pet(let id) = selectedPage {
            return store.pets.first { $0.id == id }
        }
        return nil
    }

    /// 背景 crossfade 的 identity：页变 → 背景视图替换 + opacity 过渡。
    private var backdropID: String {
        switch selectedPage {
        case .pet(let id): id.uuidString
        case .add:         "add"
        case nil:          "none"
        }
    }

    private var dotIndex: Int {
        switch selectedPage {
        case .pet(let id): store.pets.firstIndex { $0.id == id } ?? 0
        case .add:         store.pets.count
        case nil:          0
        }
    }
}

/// 顶部沉浸背景区高度（HomeView 背景层与 HomePetPage 文字对齐共用，屏幕顶起算）。
private let homeBackdropHeight: CGFloat = 500

// MARK: - 单宠物沉浸页（顶部全幅背景图 + hero 区 + 该宠物的待办/提醒卡）

private struct HomePetPage: View {
    @Environment(PetBookStore.self) private var store

    let pet: Pet
    let notificationAuthorized: Bool
    let onCompliance: (ComplianceDestination) -> Void
    let onStartCompletion: () -> Void

    @State private var backdropItem: PhotosPickerItem?

    /// 宠物页背景恒有真实画面（背景图或物种视频占位，见 HomePetBackdrop）→ hero 文字恒走材质 + 阴影。
    /// 原语义「是否设了背景图」已随视频占位失效（深色字压视频暗部会看不清）；
    /// 未来若加纯色背景形态，可改回 `pet.backgroundAssetName != nil` 判定。
    private var hasPhotoBackdrop: Bool { true }

    private var pendingSteps: [ProfileCompletionStep] {
        ProfileCompletionFeed.pendingSteps(for: pet, store: store, notificationAuthorized: notificationAuthorized)
    }

    /// 换背景选图 sheet 开关（整个背景照片区域点击触发，无独立按钮）。
    @State private var showBackdropPicker = false

    var body: some View {
        // 背景已上提到 HomeView pager 外层（另一个项目的做法），本页只排内容。
        // GeometryReader 取顶部 safe area：hero 文字压到「照片底缘 - 呼吸位」，
        // 照片高度从屏幕顶起算而页面内容从 safe area 下起算，差值须动态补偿（机型各异）。
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: PPSpacing.xl) {
                    heroArea(topInset: proxy.safeAreaInsets.top)

                    cards
                        .padding(.horizontal, PPSpacing.md)
                }
                .padding(.bottom, 150)   // 浮层 tab bar + page dots 留白
            }
            .scrollIndicators(.hidden)
        }
        .photosPicker(isPresented: $showBackdropPicker, selection: $backdropItem, matching: .images)
        .onChange(of: backdropItem) { _, item in
            handleBackdropSelection(item)
        }
    }

    // MARK: hero 区（头像 + 名字 + 副标题 → 点击进详情；照片空白区点击 = 换背景，无独立按钮）

    private func heroArea(topInset: CGFloat) -> some View {
        HStack(alignment: .bottom, spacing: PPSpacing.md) {
            NavigationLink {
                PetDetailView(pet: pet)
            } label: {
                VStack(alignment: .leading, spacing: PPSpacing.sm) {
                    PPPetAvatar(pet: pet, size: 100)
                        .padding(.top, 80)

                    Text(pet.name)
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(hasPhotoBackdrop
                                         ? AnyShapeStyle(.ultraThickMaterial)
                                         : AnyShapeStyle(Color.ppTextPrimary))

                    Text(heroSubtitle)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(hasPhotoBackdrop
                                         ? AnyShapeStyle(.ultraThickMaterial)
                                         : AnyShapeStyle(Color.ppTextSecondary))
                }
                .shadow(color: hasPhotoBackdrop ? .black.opacity(0.35) : .clear, radius: 4, x: 0, y: 1)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, PPSpacing.xl)
        // 整个背景照片可视区可点击换背景（头像/名字的 NavigationLink 优先吃掉自己区域的点击，
        // 其余空白落到这里 → 弹 PhotosPicker）
        .contentShape(Rectangle())
        .onTapGesture {
            showBackdropPicker = true
        }
    }

    /// "Cat · British Shorthair · 2 yrs"（与 PetDetailView hero 同款口径）
    private var heroSubtitle: String {
        var parts: [String] = [pet.species.displayName]
        if let breed = pet.breed, !breed.isEmpty { parts.append(breed) }
        if let age = PetFormat.ageString(from: pet.dob) { parts.append(age) }
        return parts.joined(separator: " · ")
    }

    // MARK: 内容卡（全部只属于本页宠物）

    @ViewBuilder
    private var cards: some View {
        // 档案未完成：引导卡优先，完成前不催 Next Steps（与旧版全局逻辑同口径）
        if !pendingSteps.isEmpty {
            HomeProfileCompletionCard(pet: pet, pendingSteps: pendingSteps, onTap: onStartCompletion)
        } else {
            let steps = HomeFeed.nextSteps(store: store).filter { $0.pet.id == pet.id }
            if !steps.isEmpty {
                VStack(alignment: .leading, spacing: PPSpacing.sm) {
                    Text("NEXT STEPS")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .tracking(0.8)
                        .foregroundStyle(Color.ppTextSecondary)

                    VStack(spacing: PPSpacing.md) {
                        ForEach(steps) { step in
                            HomeNextStepCard(step: step, onCompliance: onCompliance)
                        }
                    }
                }
            }
        }

        let reminders = HomeFeed.upcomingReminders(store: store)
            .filter { $0.pet.id == pet.id && $0.kind != .vetAppointment }
        if !reminders.isEmpty {
            HomeReminderTimeline(reminders: reminders, showsAvatar: false)
        }

        if pet.species == .dog {
            HomeComplianceCard(dogs: [pet]) { dog in
                onCompliance(.hdbChecker(pet: dog))
            }
        }
    }

    // MARK: 背景选图（downscale → 上传后端落 background_path；mock/失败降级本地缓存）

    private func handleBackdropSelection(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                SWAlertManager.shared.show(.error, message: "Failed to load photo")
                return
            }
            let scaled = image.downscaled(maxDimension: 1200)
            guard let jpegData = scaled.jpegData(compressionQuality: 0.85) else {
                SWAlertManager.shared.show(.error, message: "Failed to load photo")
                return
            }
            do {
                try await store.replaceBackground(petID: pet.id, jpegData: jpegData)
                SWAlertManager.shared.show(.success, message: "Background updated")
            } catch {
                // mock 模式 / 上传失败：降级本地缓存（与头像 handlePhotoSelection 降级同套路）
                let localKey = "local/\(pet.id)/backdrop"
                ImageCache.shared.store(scaled, forKey: localKey)
                var updated = pet
                updated.backgroundAssetName = localKey
                store.updatePet(updated)
                SWAlertManager.shared.show(.success, message: "Background updated")
            }
        }
    }
}

// MARK: - 沉浸背景层（pets.background_path 独立资产）
// 挂在 HomeView pager 外层（不在 TabView 子页内）。三态：
//   有背景图 → 图；宠物页未设背景 → 物种视频占位（CatVideo/DogVideo，onboarding 转盘同资源）；
//   pet = nil（add 页）→ 通用 mesh + 爪印浮印。

private struct HomePetBackdrop: View {
    let pet: Pet?
    let height: CGFloat

    /// 宠物页背景恒有真实画面（背景图或视频占位）→ 开图底黑渐变保文字；仅 add 页 mesh 不压暗。
    private var hasVisual: Bool { pet != nil }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                if let pet, pet.backgroundAssetName != nil {
                    PetBackdropImageLayer(pet: pet)
                } else if let pet {
                    // 未设背景的宠物页：物种视频占位（与 onboarding 转盘同资源，品牌一致）
                    PPVideoView(resourceName: pet.species == .cat ? "CatVideo" : "DogVideo")
                } else {
                    // add 页：暖色流动 mesh（onboarding welcome 卡同款基因）+ 爪印浮印
                    PPMeshBackground()
                    Text("🐾")
                        // emoji 固定字号例外：装饰性浮印需精确尺寸（同 PetPhotoLayer 口径）
                        .font(.system(size: 96))
                        .opacity(0.35)
                        .offset(y: -30)
                }
            }
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .clipped()
            // 图底黑渐变：hero 文字在照片 / 视频画面上都可读（add 页 mesh 不压暗）
            .overlay {
                if hasVisual {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0.35),
                            .init(color: .black.opacity(0.42), location: 1.0)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
            }
            // 底缘过渡回米白内容区（浅色 app 的沉浸式适配）
            .overlay(alignment: .bottom) {
                LinearGradient(
                    colors: [Color.ppBackground.opacity(0), Color.ppBackground],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 150)
            }

            // 照片区以下填米白：背景层现在是整页 background，须自己铺满剩余高度
            Color.ppBackground
        }
        .ignoresSafeArea()
    }
}

/// 背景图三态加载层（仿 PetPhotoLayer：init 同步查缓存消闪 → task 拉 signed URL 下载）。
/// 源 = pet.backgroundAssetName：远程 object path（含 "/"）→ ImageCache + 后端签名 URL；
/// 本地 Asset 名（mock，不含 "/"）→ Image(asset)；下载中 → 米白占位（正常仅首次出现）。
private struct PetBackdropImageLayer: View {
    let pet: Pet

    @Environment(PetBookStore.self) private var store
    @State private var image: UIImage?

    init(pet: Pet) {
        self.pet = pet
        // 首帧消闪：远程背景在 init 同步查内存/磁盘缓存，命中即作为 @State 初值
        if let path = pet.backgroundAssetName, path.contains("/") {
            _image = State(initialValue: ImageCache.shared.image(forKey: path))
        } else {
            _image = State(initialValue: nil)
        }
    }

    /// task 触发 key：path（首挂载 / 切 pet）+ backgroundVersion（换背景）任一变化都重跑。
    private struct TaskKey: Equatable {
        let path: String?
        let version: Int
    }

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let asset = pet.backgroundAssetName, !asset.contains("/") {
                Image(asset)
                    .resizable()
                    .scaledToFill()
            } else {
                Color.ppSurface   // 远程背景首次下载中的占位
            }
        }
        .task(id: TaskKey(path: pet.backgroundAssetName, version: store.backgroundVersion[pet.id] ?? 0)) {
            await loadRemoteIfNeeded()
        }
    }

    private func loadRemoteIfNeeded() async {
        guard let path = pet.backgroundAssetName, path.contains("/") else { return }

        if let cached = ImageCache.shared.image(forKey: path) {
            image = cached
            return
        }
        guard let urlString = await store.remoteBackgroundURL(for: pet),
              let url = URL(string: urlString) else { return }
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let downloaded = UIImage(data: data) else { return }

        ImageCache.shared.store(downloaded, forKey: path)
        image = downloaded
    }
}

// MARK: - 末页：添加宠物

private struct AddPetPage: View {
    /// 呈现 AddPetFlow 的责任在 HomeView 层（稳定宿主）：本页在 TabView 内，
    /// submit 建宠后 pets 变化会重排子页 —— cover 若挂在本页会被连带拆除，庆祝屏直接断档。
    let onAdd: () -> Void

    var body: some View {
        VStack(spacing: PPSpacing.xl) {
            Spacer()

            Image(systemName: "plus")
                .font(.largeTitle)
                .fontWeight(.semibold)
                .foregroundStyle(Color.ppPrimary)
                .frame(width: 96, height: 96)
                .background(
                    RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                        .fill(Color.ppSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                        .strokeBorder(
                            Color.ppPrimary.opacity(0.4),
                            style: StrokeStyle(lineWidth: 2, dash: [5])
                        )
                )

            VStack(spacing: PPSpacing.sm) {
                Text("Add another pet")
                    .font(.title3)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)

                Text("Track their vaccines, licence and reminders too.")
                    .font(.subheadline)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, PPSpacing.xxl)

            PPPrimaryButton(title: "Add a pet", systemImage: "plus") {
                onAdd()
            }
            .padding(.horizontal, PPSpacing.xxxl)

            Spacer()
            Spacer()
        }
    }
}

// MARK: - C1. 店铺预约（横向 viewAligned 卡片滚动）

private struct HomeAppointmentStrip: View {
    let appointments: [HomeReminder]

    // 预约卡点击 → 切到 Orders tab（完整信息在 Orders，不另起 push）
    @Environment(PetBookTabBarController.self) private var tabBar

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            Text("APPOINTMENTS")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: PPSpacing.md) {
                    ForEach(appointments) { appt in
                        Button {
                            tabBar.selectedTab = .orders
                        } label: {
                            card(appt)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .scrollTargetLayout()
            }
            // 卡片逐个对齐分页，左右滑动停在卡片边缘
            .scrollTargetBehavior(.viewAligned)
        }
    }

    private func card(_ r: HomeReminder) -> some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            HStack {
                if let status = r.apptStatus {
                    apptStatusBadge(status)
                }
                Spacer()
                Image(systemName: "calendar")
                    .font(.subheadline)
                    .foregroundStyle(Color.ppPrimary)
            }

            HStack(spacing: PPSpacing.sm) {
                PPPetAvatar(pet: r.pet, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title)
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                        .lineLimit(1)
                    Text(r.pet.name)
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                }
                Spacer(minLength: 0)
            }

            Text(dateTimeText(r.date))
                .font(.footnote)
                .fontWeight(.semibold)
                .foregroundStyle(Color.ppTextSecondary)
        }
        .padding(PPSpacing.lg)
        .frame(width: 240, alignment: .leading)
        .ppCard()
    }

    /// 预约状态徽章（与 AppointmentsView 语义一致：requested=ppWarning / confirmed=ppSuccess）。
    private func apptStatusBadge(_ status: AppointmentStatus) -> some View {
        let tint: Color = status == .confirmed ? Color.ppSuccess : Color.ppWarning
        let label = status == .confirmed ? "Confirmed" : "Requested"
        return Text(label)
            .font(.caption)
            .fontWeight(.bold)
            .foregroundStyle(tint)
            .padding(.horizontal, PPSpacing.sm)
            .padding(.vertical, PPSpacing.xs)
            .background(Capsule().fill(tint.opacity(0.15)))
    }

    /// "May 30 · 2:30 PM"
    private func dateTimeText(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

// MARK: - C2. 到期提醒时间线（疫苗 / 驱虫 / 复诊 / 牌照）
// 设计语言 v2：整个 section 收进一张纸面卡，内部按 Overdue / Next 30 days / Later 分组，
// 左侧图标节点 + 组内连接线构成时间轴；紧急度三档配色走 PPUrgency。

private struct HomeReminderTimeline: View {
    let reminders: [HomeReminder]
    /// 行尾宠物小头像。per-pet 沉浸页里整页都是同一只宠物，传 false 去掉冗余头像。
    var showsAvatar: Bool = true

    /// 时间分组（reminders 已按日期升序，空组不显示）。
    private struct TimelineGroup: Identifiable {
        let title: String
        let tint: Color
        let items: [HomeReminder]
        var id: String { title }
    }

    private var groups: [TimelineGroup] {
        let overdue = reminders.filter { HomeFeed.daysUntil($0.date) < 0 }
        let soon    = reminders.filter { (0...30).contains(HomeFeed.daysUntil($0.date)) }
        let later   = reminders.filter { HomeFeed.daysUntil($0.date) > 30 }
        return [
            TimelineGroup(title: "OVERDUE", tint: Color.ppDanger, items: overdue),
            TimelineGroup(title: "NEXT 30 DAYS", tint: Color.ppTextSecondary, items: soon),
            TimelineGroup(title: "LATER", tint: Color.ppTextSecondary, items: later),
        ].filter { !$0.items.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.lg) {
            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: PPSpacing.md) {
                    Text(group.title)
                        .font(.caption2)
                        .fontWeight(.semibold)
                        .tracking(0.8)
                        .foregroundStyle(group.tint)

                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(group.items.enumerated()), id: \.element.id) { index, r in
                            row(r, isLast: index == group.items.count - 1)
                        }
                    }
                }
            }
        }
        .padding(PPSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ppCard()
    }

    private func row(_ r: HomeReminder, isLast: Bool) -> some View {
        // 生日是庆祝不是催办，恒走中性档；其余按到期天数分三档
        let urgency = PPUrgency(daysUntil: HomeFeed.daysUntil(r.date), muted: r.kind == .birthday)

        return HStack(alignment: .top, spacing: PPSpacing.md) {
            // 节点列：图标容器 + 组内连接线（最后一行不画线）
            VStack(spacing: 0) {
                Image(systemName: icon(r.kind))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(urgency.iconForeground)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(urgency.iconBackground))

                if !isLast {
                    Rectangle()
                        .fill(Color.ppBorder)
                        .frame(width: 1.5)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(r.title)
                    .font(.headline)
                    .foregroundStyle(Color.ppTextPrimary)
                Text("\(r.pet.name) · \(dueText(r.date, kind: r.kind))")
                    .font(.footnote)
                    .foregroundStyle(urgency.accent)
            }
            .padding(.bottom, isLast ? 0 : PPSpacing.lg)

            Spacer()

            if showsAvatar {
                PPPetAvatar(pet: r.pet, size: 40)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// 到期提醒只含健康 / 牌照类；vetAppointment 已拆到 HomeAppointmentStrip，
    /// 此处保留 case 仅为满足 switch 完备，实际不会命中。
    private func icon(_ kind: HomeReminder.Kind) -> String {
        switch kind {
        case .vaccine:        "syringe"
        case .deworming:      "pills"
        case .licenseExpiry:  "doc.text"
        case .vetFollowUp:    "stethoscope"
        case .birthday:       "gift"
        case .vetAppointment: "calendar"
        }
    }

    /// 生日不说 "due"（庆祝不是到期，与 NotificationsView 口径一致）；其余按倒计时措辞。
    private func dueText(_ date: Date, kind: HomeReminder.Kind) -> String {
        let d = HomeFeed.daysUntil(date)
        let dateStr = date.formatted(.dateTime.month(.abbreviated).day())
        if kind == .birthday {
            return (d <= 0 ? "today 🎂" : "in \(d) days") + " · \(dateStr)"
        }
        let when: String
        switch d {
        case ..<0:  when = "overdue by \(abs(d))d"
        case 0:     when = "due today"
        case 1:     when = "due tomorrow"
        default:    when = "in \(d) days"
        }
        return "\(when) · \(dateStr)"
    }
}

// MARK: - D. HDB 合规快检入口

private struct HomeComplianceCard: View {
    let dogs: [Pet]
    /// 点某只狗 → 回调给 HomeView 设置 push 目标（带入该狗的 HDB 检查器）。
    let onSelect: (Pet) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            Text("HDB COMPLIANCE")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            // 每只狗一行可点（push 检查器并带入该狗，能查到具体宠物），整体仍是一张卡。
            VStack(spacing: 0) {
                ForEach(Array(dogs.enumerated()), id: \.element.id) { idx, dog in
                    Button {
                        onSelect(dog)
                    } label: {
                        dogRow(dog)
                    }
                    .buttonStyle(.ppPress)

                    if idx < dogs.count - 1 {
                        Divider()
                    }
                }
            }
            .padding(PPSpacing.md)
            .frame(maxWidth: .infinity)
            .ppCard()
        }
    }

    private func dogRow(_ dog: Pet) -> some View {
        HStack(spacing: PPSpacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(dog.name)
                    .font(.headline)
                    .foregroundStyle(Color.ppTextPrimary)
                Text(dog.breed ?? "Unknown breed")
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
            }
            Spacer()
            HDBComplianceBadge(status: status(for: dog))
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.ppTextSecondary)
        }
        .padding(.vertical, PPSpacing.sm)
        .contentShape(Rectangle())
    }

    private func status(for dog: Pet) -> HDBComplianceStatus {
        guard let breed = dog.breed,
              let s = BreedCatalog.dogStatus(for: breed) else { return .unknownMixed }
        return s
    }
}

// MARK: - E. 空状态引导

private struct HomeEmptyState: View {
    /// 同 AddPetPage：cover 由 HomeView 层呈现——建完第一只宠物后本视图整个被 pager 替换，
    /// cover 挂在这里会被连带拆除。
    let onAdd: () -> Void

    var body: some View {
        VStack(spacing: PPSpacing.lg) {
            ContentUnavailableView("No pets yet", systemImage: "pawprint.fill", description: Text("Add your first pet to track vaccines, licences and HDB compliance in one place."))
                .frame(maxHeight: 300)

            PPPrimaryButton(title: "Add a pet", systemImage: "plus") {
                onAdd()
            }
            .padding(PPSpacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.ppBackground)
    }
}

#Preview("With pets") {
    NavigationStack { HomeView() }
        .environment(PetBookStore())
        .environment(PetBookTabBarController())
}

#Preview("Empty") {
    NavigationStack { HomeView() }
        .environment(PetBookStore(useMocks: false))
        .environment(PetBookTabBarController())
}
