//
//  PetBookStore.swift
//  PetBook
//
//  全局 @Observable Store。通过 .environment(store) 注入，View 内用 @Environment(PetBookStore.self) 取。
//
//  两种数据源（DataSource）：
//    • .mock    —— 纯内存 mock（Preview / UI 调试用，零网络）。所有 Preview 默认走这条。
//    • .network —— pet 部分接真实 Supabase 后端（M1 端到端）；其余实体（owner / 健康记录 /
//                  提醒 / 诊所 / 预约）M1 仍保持 mock 不动。
//
//  pet 写操作采用「乐观更新 + 后台同步」：本地数组先改（UI 即时刷新），网络模式下后台发请求，
//  成功用后端真实行替换、失败回滚并用 SWAlert 大声暴露。这样 3 个 View 调用点（同步签名）一行不改。
//

import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class PetBookStore {

    /// 数据源模式。
    enum DataSource {
        case mock      // 纯内存 mock，零网络（Preview / UI 调试）
        case network   // pet 接真实后端，其余 M1 仍 mock
    }

    let dataSource: DataSource

    // MARK: - 网络层（仅 .network 模式构建；.mock 模式为 nil）

    private let apiClient: APIClient?
    private let authManager: AuthManager?
    private let ownerService: OwnerService?
    private let petService: PetService?
    private let photoService: PhotoService?
    private let healthService: HealthRecordService?

    /// 已从后端拉过健康记录的 pet（按 pet 懒加载，进 PetDetailView 时触发，避免首启全量拉）。
    /// 命中则不重复拉；下拉刷新 / 写操作不依赖它（写走乐观更新）。
    private var loadedHealthPetIDs: Set<UUID> = []

    /// per-pet 头像版本号：换图后自增，驱动 PPPetAvatar 的 .task 重跑去取新缓存。
    /// 必要原因：upsert 覆盖后 photo_path 不变 → 仅靠 photoAssetName 无法触发组件重载，靠此版本号兜底。
    private(set) var photoVersion: [UUID: Int] = [:]

    /// per-pet 背景图版本号（Home 沉浸页背景，与头像分离的独立资产）：换背景后自增，机制同 photoVersion。
    private(set) var backgroundVersion: [UUID: Int] = [:]

    // Owner（单主）
    var owner: Owner

    // Pets & 健康记录
    var pets: [Pet]
    var vaccinations: [VaccinationRecord]
    var dewormings: [DewormingRecord]
    var vetVisits: [VetVisitRecord]
    var weights: [WeightRecord]

    // 静态数据
    var vetClinics: [VetClinic]
    var breedRules: [BreedRule]

    // 到店预约（请求制状态卡，骨架阶段 mock 写内存）
    var appointments: [Appointment]
    // 诊所可预约服务目录（静态）
    var clinicServices: [ClinicService]
    // 诊所医生（多医生排班，静态）
    var vets: [Vet]

    /// Preview / UI 调试用构造器：纯 mock，**绝不触网**。所有 #Preview 走这条。
    /// - useMocks: true = 满 mock 种子；false = 空态（测 empty-state UI）。
    init(useMocks: Bool = true) {
        self.dataSource = .mock
        self.apiClient = nil
        self.authManager = nil
        self.ownerService = nil
        self.petService = nil
        self.photoService = nil
        self.healthService = nil

        if useMocks {
            self.owner = .mock
            self.pets = Pet.mocks
            self.vaccinations = VaccinationRecord.mocks
            self.dewormings = DewormingRecord.mocks
            self.vetVisits = VetVisitRecord.mocks
            self.weights = WeightRecord.mocks
            self.vetClinics = Self.initialClinics()   // bundle 兜底快照（当前 313 家，空则回退 mock；启动后由 GET /v1/clinics 覆盖）
            self.breedRules = BreedRule.mocks
            self.appointments = Appointment.mocks
            self.clinicServices = ClinicService.catalog
            self.vets = Vet.mocks
        } else {
            self.owner = Owner()
            self.pets = []
            self.vaccinations = []
            self.dewormings = []
            self.vetVisits = []
            self.weights = []
            self.vetClinics = []
            self.breedRules = []
            self.appointments = []
            self.clinicServices = ClinicService.catalog   // 服务目录是诊所静态数据，始终可用
            self.vets = Vet.mocks                          // 医生排班同为诊所静态数据
        }
    }

    /// 数据源可选构造器（App 入口用）。
    /// - .mock：等价于 init(useMocks: true)。
    /// - .network：pet 接真实后端；其余实体（owner / 健康记录 / 提醒 / 诊所 / 预约 / 医生）
    ///   M1 仍保持 mock 种子，待后续按 PRD 逐个接真实实现。
    ///   pets 初始为空，由 bootstrap() 登录后从后端拉取。
    init(dataSource: DataSource) {
        self.dataSource = dataSource

        switch dataSource {
        case .mock:
            self.apiClient = nil
            self.authManager = nil
            self.ownerService = nil
            self.petService = nil
            self.photoService = nil
            self.healthService = nil
            self.owner = .mock
            self.pets = Pet.mocks
            // mock 模式：健康记录吃 mock 种子（petID 对应 mock pet）
            self.vaccinations = VaccinationRecord.mocks
            self.dewormings = DewormingRecord.mocks
            self.vetVisits = VetVisitRecord.mocks
            self.weights = WeightRecord.mocks

        case .network:
            let client = APIClient()
            self.apiClient = client
            self.authManager = AuthManager(client: client)
            self.ownerService = OwnerService(client: client)
            self.petService = PetService(client: client)
            self.photoService = PhotoService(client: client)
            self.healthService = HealthRecordService(client: client)
            self.owner = .mock          // 占位；bootstrap 拉真实 owner 覆盖
            self.pets = []              // 由 bootstrap() 从后端拉取
            // network 模式：健康记录初始为空，进 PetDetailView 时按 pet 懒加载（loadHealthRecords）。
            // 绝不塞 mock 种子——种子的 petID 指向 mock pet，与后端真实 pet id 对不上，会污染列表。
            self.vaccinations = []
            self.dewormings = []
            self.vetVisits = []
            self.weights = []
        }

        // 诊所名录走真实政府数据：先同步用 bundle 兜底填充（即时有点），bootstrap 再异步拉远端覆盖。
        self.vetClinics = Self.initialClinics()
        // 以下静态 / 演示数据 M1 仍保持 mock 种子（无论 .mock 还是 .network）。
        self.breedRules = BreedRule.mocks
        self.appointments = Appointment.mocks
        self.clinicServices = ClinicService.catalog
        self.vets = Vet.mocks
    }

    // MARK: - 启动引导（网络模式）

    /// 网络模式启动引导：匿名登录 / 复用 token → 拉取 pets → 并发拉所有 pet 的健康记录。
    /// .mock 模式直接返回（pets 已是 mock 种子）。App 入口在 .task 里 await 调用。
    ///
    /// 为何首启拉全量健康记录：Home 的疫苗 / 驱虫到期提醒需要全量记录才准，
    /// 不能依赖「用户进过某 pet 详情页」才有数据（否则没进详情的 pet 提醒永远是空）。
    /// 拉取方式：pets 到手后对每只 pet 并发拉（复用 loadHealthRecords，内部已 4 类并发 + 失败降级），
    /// 各 pet 之间也并发，不串行卡首启。健康记录拉失败不影响 pets（已就绪），只各自降级。
    func bootstrap() async {
        guard dataSource == .network,
              let authManager, let petService else { return }

        do {
            try await authManager.bootstrap()      // 复用 Keychain token 或匿名登录
            let remotePets = try await petService.list()
            self.pets = remotePets
        } catch {
            // 启动拉取失败：保持空列表，大声暴露（不静默吞错）
            SWAlertManager.shared.show(.error, message: "Failed to load pets: \(error.localizedDescription)")
            return   // pets 都没拿到，无需再拉健康记录
        }

        // 拉 owner profile（失败静默降级保持占位，不炸 bootstrap；用户进 Profile 仍可见占位）
        if let ownerService, let remoteOwner = try? await ownerService.get() {
            self.owner = remoteOwner
        }

        // pets 已就绪 → 并发拉所有 pet 的健康记录（疫苗 / 驱虫 / 就诊 / 体重）。
        // 复用 loadHealthRecords：单 pet 内 4 类已并发，这里再让多 pet 之间并发。
        // 失败已在 loadHealthRecords 内部各自降级（SWAlert），不会冒泡炸掉整个 bootstrap。
        let petIDs = self.pets.map(\.id)
        await withTaskGroup(of: Void.self) { group in
            for id in petIDs {
                group.addTask { [weak self] in
                    await self?.loadHealthRecords(petID: id)
                }
            }
        }

        // 健康记录全就绪 → 首次排程本地通知提醒
        scheduleReminders()
    }

    // MARK: - Apple 关联（F7.5：匿名 → 永久）

    /// 关联 Apple ID：网络模式调后端 /v1/auth/link，成功后乐观更新本地 owner；
    /// mock 模式无后端，直接置位用于演示。返回是否成功。
    /// 失败（含后端校验失败）大声 toast，不静默吞。
    func linkApple(idToken: String, nonce: String?, fullName: String?) async -> Bool {
        guard dataSource == .network, let authManager else {
            // mock / 无后端：直接置位演示
            owner.hasLinkedAppleID = true
            if let fullName, !fullName.isEmpty { owner.displayName = fullName }
            SWAlertManager.shared.show(.success, message: "Apple ID linked")
            return true
        }
        do {
            let resp = try await authManager.linkApple(idToken: idToken, nonce: nonce, fullName: fullName)
            if resp.mode == "signed_in" {
                // 该 Apple 已绑账号 → authManager 已切到那个 user 的 token → 重拉它的数据（换机 / 重装找回）
                await reloadAfterAccountSwitch()
                owner.hasLinkedAppleID = true
                if let email = resp.email { owner.email = email }
                SWAlertManager.shared.show(.success, message: "Welcome back — your pets are restored")
            } else {
                // 首次绑定：apple 绑到当前匿名 user，数据保留；display name 直接拿 Apple name（仅首次返回）
                owner.hasLinkedAppleID = true
                if let email = resp.email { owner.email = email }
                if let fullName, !fullName.isEmpty { owner.displayName = fullName }
                SWAlertManager.shared.show(.success, message: "Apple ID linked — your records are protected")
            }
            return true
        } catch {
            SWAlertManager.shared.show(.error, message: "Apple sign-in failed: \(error.localizedDescription)")
            return false
        }
    }

    /// signed_in（换机 / 重装找回）后：清当前匿名账号本地数据，重新拉「已绑 user」的 pets + 健康记录。
    /// authManager.linkApple 已切换 token，故这里的网络请求自动以已绑 user 身份发出。
    private func reloadAfterAccountSwitch() async {
        guard let petService else { return }
        owner = Owner()
        loadedHealthPetIDs = []
        vaccinations = []
        dewormings = []
        vetVisits = []
        weights = []
        photoVersion = [:]
        backgroundVersion = [:]
        do {
            pets = try await petService.list()
        } catch {
            pets = []
            SWAlertManager.shared.show(.error, message: "Signed in, but failed to load your pets: \(error.localizedDescription)")
            return
        }
        await withTaskGroup(of: Void.self) { group in
            for id in pets.map(\.id) {
                group.addTask { [weak self] in await self?.loadHealthRecords(petID: id) }
            }
        }

        // 账号切换后数据重载完 → 重排提醒
        scheduleReminders()
    }

    // MARK: - Owner profile 更新（接后端持久化）

    /// 更新 owner profile：乐观改本地 → PATCH 后端 → 失败回滚 + 大声 toast。
    /// mock 模式仅改本地（演示）。每次传 4 字段快照，后端整体更新（名字 / 邮编 / 住宅类型 / 电话）。
    func updateOwner(_ apply: (inout Owner) -> Void) async {
        let backup = owner
        apply(&owner)   // 乐观更新本地，UI 立即反映

        guard dataSource == .network, let ownerService else { return }
        do {
            let saved = try await ownerService.update(owner)
            owner = saved   // 用后端返回覆盖（含 updated_at 等规范化值）
        } catch {
            owner = backup  // 回滚
            SWAlertManager.shared.show(.error, message: "Failed to save: \(error.localizedDescription)")
        }
    }

    // MARK: - 删除账号（F7.4：不可逆）

    /// 永久删除账号：网络模式调后端级联清库 + 重新匿名；mock 模式仅清本地演示。
    /// 成功后本地数据全清、owner 复位（hasLinkedAppleID=false），等价全新匿名用户，
    /// UI（@Observable）自动刷新：Profile 头条重现 Apple 按钮、Home 回空状态。
    func deleteAccount() async -> Bool {
        guard dataSource == .network, let authManager else {
            resetLocalData()
            return true
        }
        do {
            try await authManager.deleteAccount()   // 后端级联删 + 重新匿名
            resetLocalData()
            return true
        } catch {
            SWAlertManager.shared.show(.error, message: "Delete account failed: \(error.localizedDescription)")
            return false
        }
    }

    /// 清空本地内存数据，owner 复位为全新空状态（删账号后调用）。
    private func resetLocalData() {
        owner = Owner()
        pets = []
        vaccinations = []
        dewormings = []
        vetVisits = []
        weights = []
        loadedHealthPetIDs = []
        photoVersion = [:]
        backgroundVersion = [:]
        scheduleReminders()   // 数据清空 → 清掉所有待发提醒
    }

    // MARK: - 健康记录懒加载（network 模式，进 PetDetailView 时按 pet 拉）

    /// 拉某 pet 的 4 类健康记录并合并进各数组。
    /// 设计取舍：按 pet 懒加载（非首启全量），进详情页触发；同一 pet 命中缓存集合后不重复拉。
    /// - force: true 时无视缓存强制重拉（预留下拉刷新用，当前无 UI 入口）。
    /// mock 模式 / 无 healthService 直接返回（数据已是 mock 种子全量在内存）。
    func loadHealthRecords(petID: UUID, force: Bool = false) async {
        guard dataSource == .network, let healthService else { return }
        if !force && loadedHealthPetIDs.contains(petID) { return }

        do {
            // 4 类并发拉取，缩短进详情页的等待
            async let vac = healthService.listVaccinations(petID: petID)
            async let dew = healthService.listDewormings(petID: petID)
            async let visits = healthService.listVetVisits(petID: petID)
            async let wts = healthService.listWeights(petID: petID)
            let (vaccinations, dewormings, vetVisits, weights) = try await (vac, dew, visits, wts)

            // 用拉到的记录替换「该 pet」的部分：先删掉本地属于该 pet 的旧记录，再并入新拉的。
            // 这样多 pet 的记录在同一数组里互不干扰，重复进详情页也不会累加重复。
            mergeHealthRecords(petID: petID,
                               vaccinations: vaccinations,
                               dewormings: dewormings,
                               vetVisits: vetVisits,
                               weights: weights)
            loadedHealthPetIDs.insert(petID)
        } catch {
            // 拉取失败：保持现状（不清空已有），大声暴露
            SWAlertManager.shared.show(.error, message: "Failed to load health records: \(error.localizedDescription)")
        }
    }

    /// 用后端拉到的某 pet 全量记录替换本地该 pet 的对应记录（其余 pet 不动）。
    private func mergeHealthRecords(petID: UUID,
                                    vaccinations newVac: [VaccinationRecord],
                                    dewormings newDew: [DewormingRecord],
                                    vetVisits newVisits: [VetVisitRecord],
                                    weights newWeights: [WeightRecord]) {
        self.vaccinations.removeAll { $0.petID == petID }
        self.vaccinations.append(contentsOf: newVac)
        self.dewormings.removeAll { $0.petID == petID }
        self.dewormings.append(contentsOf: newDew)
        self.vetVisits.removeAll { $0.petID == petID }
        self.vetVisits.append(contentsOf: newVisits)
        self.weights.removeAll { $0.petID == petID }
        self.weights.append(contentsOf: newWeights)
    }

    // MARK: - 便利查询

    func pet(id: UUID) -> Pet? {
        pets.first(where: { $0.id == id })
    }

    /// signed URL 短期缓存：key = photo_path（稳定），value = (url, 过期时刻)。
    /// TTL 内复用同一个 signed URL，避免每次进列表 / 详情都重签（省往返、提速）。
    /// 注意：这是「签名 URL」的缓存，与「图片字节」的 ImageCache 是两层不同的东西。
    private var signedURLCache: [String: (url: String, expiry: Date)] = [:]

    /// signed URL 本地复用时长（后端签发的 URL 实际有效期更长，这里保守取 1h，到点重签）。
    private static let signedURLTTL: TimeInterval = 60 * 60

    /// 取某 pet 远程照片的临时签名 URL（network 模式且该 pet 有远程照片时）。
    /// mock 模式、photoAssetName 非远程路径（不含 "/"，即本地 Asset 名）、或后端无照片(404) → nil。
    /// TTL 1h 内按 photo_path 复用已签 URL，不重复请求；过期或未缓存才向后端重签。
    /// 供 PPPetAvatar 在 .task 中异步拉取后喂下载器。
    func remotePhotoURL(for pet: Pet) async -> String? {
        guard dataSource == .network, let photoService else { return nil }
        // 远程照片标识：photoAssetName 是后端 object path（含 "/"，如 {owner_id}/{pet_id}.jpg）。
        // 本地 Asset 名（如 "pet-mochi"）不含 "/"，走本地分支，不请求 signed URL。
        guard let path = pet.photoAssetName, path.contains("/") else { return nil }

        // TTL 内命中 → 复用，不重签
        if let entry = signedURLCache[path], entry.expiry > Date() {
            return entry.url
        }

        // 过期 / 未缓存 → 向后端重签
        guard let url = try? await photoService.photoURL(petId: pet.id) else { return nil }
        signedURLCache[path] = (url, Date().addingTimeInterval(Self.signedURLTTL))
        return url
    }

    /// 让某 photo_path 的 signed URL 缓存立即失效（换图后路径不变时调用，强制下次重签）。
    func invalidateSignedURL(forPath path: String) {
        signedURLCache[path] = nil
    }

    /// 取某 pet 远程背景图的临时签名 URL（Home 沉浸页背景，机制同 remotePhotoURL）。
    /// mock 模式、backgroundAssetName 非远程路径（不含 "/"）、或后端无背景(404) → nil。
    func remoteBackgroundURL(for pet: Pet) async -> String? {
        guard dataSource == .network, let photoService else { return nil }
        guard let path = pet.backgroundAssetName, path.contains("/") else { return nil }

        if let entry = signedURLCache[path], entry.expiry > Date() {
            return entry.url
        }

        guard let url = try? await photoService.backgroundURL(petId: pet.id) else { return nil }
        signedURLCache[path] = (url, Date().addingTimeInterval(Self.signedURLTTL))
        return url
    }

    func vaccinations(of petID: UUID) -> [VaccinationRecord] {
        vaccinations.filter { $0.petID == petID }
    }

    func dewormings(of petID: UUID) -> [DewormingRecord] {
        dewormings.filter { $0.petID == petID }
    }

    func vetVisits(of petID: UUID) -> [VetVisitRecord] {
        vetVisits.filter { $0.petID == petID }
    }

    func weights(of petID: UUID) -> [WeightRecord] {
        weights.filter { $0.petID == petID }.sorted { $0.recordedDate < $1.recordedDate }
    }

    /// 当前体重（一处真相）：该 pet 最新一条体重记录的 kg；无记录返回 nil。
    /// 取代已删除的 Pet.currentWeightKg —— 体重统一走 WeightRecord 时间序列，最新即当前。
    /// （weights(of:) 已按 recordedDate 升序，末条为最新。）
    func currentWeight(for petID: UUID) -> Double? {
        weights(of: petID).last?.weightKg
    }

    func breedsFor(_ species: Species) -> [BreedRule] {
        breedRules.filter { $0.species == species }
    }

    func clinic(id: UUID?) -> VetClinic? {
        guard let id else { return nil }
        return vetClinics.first(where: { $0.id == id })
    }

    // MARK: - 诊所名录（真实政府数据：bundle 兜底 + 远端覆盖）

    /// 歇业店全局过滤（产品负责人 2026-07-11 拍板：地图上没有的东西对 app 没意义）。
    /// CLOSED_TEMPORARILY / CLOSED_PERMANENTLY（VetClinic.closure 非 nil）两档都不展示——
    /// 地图 marker 与列表模式统一在此数据源层过滤，不散在各视图。
    /// 临时歇业店重开后（Google businessStatus 变回 OPERATIONAL，后端定期刷新更新）自动恢复显示。
    private static func displayable(_ clinics: [VetClinic]) -> [VetClinic] {
        clinics.filter { $0.closure == nil }
    }

    /// 启动时同步取的诊所初值：优先 bundle 打包的真实名录；bundle 解析为空才回退 mock 4 家
    /// （Preview / 异常兜底，保证地图永远有点可看）。经 displayable 过滤掉歇业店。
    private static func initialClinics() -> [VetClinic] {
        let bundled = ClinicDirectoryService.loadBundled()
        return displayable(bundled.isEmpty ? VetClinic.mocks : bundled)
    }

    /// 异步拉远端最新诊所名录覆盖本地（bootstrap / 任意需要刷新时调）。经 displayable 过滤掉歇业店。
    /// 失败静默降级——保持已显示的 bundle 数据不动（断网 / 远端故障不该清空地图、不该弹错）。
    func loadClinics() async {
        if let remote = try? await ClinicDirectoryService.fetchRemote(), !remote.isEmpty {
            self.vetClinics = Self.displayable(remote)
        }
    }

    /// 众包回写诊所电话：把 ClinicMapSheet 用 MKLocalSearch 查到的电话回写后端（带鉴权 POST），
    /// 让其他用户复用（第一个查到的人补齐，后端只在 phone IS NULL 时写）。
    /// - rawClinicId：后端原始 string id（VetClinic.rawId）。
    /// - mock 模式 apiClient 为 nil → 无后端可写，直接跳过（不报错）。
    /// - 失败静默：由 ClinicDirectoryService.reportPhone 内部吞掉，绝不抛给 UI。
    func reportClinicPhone(rawClinicId: String, phone: String) async {
        guard let apiClient else { return }
        await ClinicDirectoryService.reportPhone(client: apiClient, rawClinicId: rawClinicId, phone: phone)
    }

    /// 铃铛红点：已进入提醒窗口的事项数（= NotificationsView 列表条数，红点亮即点进去有内容）。
    var unreadNotificationCount: Int {
        ReminderPlanner.active(HomeFeed.upcomingReminders(store: self)).count
    }

    /// 重排本地通知提醒：基于当前内存里的到期数据全量重排（幂等）。数据一变就调。
    /// HomeFeed.upcomingReminders 是纯逻辑派生，同一来源也喂给 NotificationsView 展示 → 二者一致。
    func scheduleReminders() {
        let reminders = HomeFeed.upcomingReminders(store: self)
        Task { await ReminderScheduler.shared.reschedule(reminders: reminders) }
    }

    // MARK: - Mutations（onboarding 用）

    /// 新增宠物。同步签名（View 调用点不变）：本地立即 append → UI 即时刷新。
    /// 网络模式：后台 POST，成功用后端真实行（真实 id / owner_id / created_at）替换本地临时对象；
    /// 失败回滚本地插入并用 SWAlert 报错。
    /// - photoData: 用户选中照片的 JPEG（仅 onboarding/加宠物流程传）。pet 创建成功后单独上传，
    ///   上传成功把后端返回的 photoPath 写回该 pet 的 photoAssetName（作远程照片标识，供 PPPetAvatar 取 signed URL）。
    /// - initialWeightKg: onboarding 填的「当前体重」（pets 表已无此列）→ 写成第一条 WeightRecord。
    ///   必须等 pet 落库拿到真实 id 后再写（用 saved.id），否则记录挂错 pet。mock 模式用本地临时 id。
    func addPet(_ pet: Pet, photoData: Data? = nil, initialWeightKg: Double? = nil) {
        pets.append(pet)
        scheduleReminders()

        guard dataSource == .network, let petService else {
            // mock 模式：pet 不触网，初始体重直接挂在本地临时 id 上（addWeightRecord 内部 mock 路径只改内存）
            if let initialWeightKg {
                addWeightRecord(WeightRecord(petID: pet.id, recordedDate: Date(), weightKg: initialWeightKg))
            }
            return
        }

        let tempID = pet.id
        Task { @MainActor in
            do {
                let saved = try await petService.create(pet)
                // 用后端返回的真实行替换本地临时对象（按临时 id 定位）
                if let idx = pets.firstIndex(where: { $0.id == tempID }) {
                    pets[idx] = saved
                }
                // pet 已落库 → 用真实 pet_id 写第一条体重记录（onboarding 填的当前体重 = 首条 WeightRecord）
                if let initialWeightKg {
                    addWeightRecord(WeightRecord(petID: saved.id, recordedDate: Date(), weightKg: initialWeightKg))
                }
                // pet 已落库 → 若带了照片，用真实 pet_id 上传，成功把 photoPath 写回（远程照片标识）
                if let photoData, let photoService {
                    await uploadPhoto(petID: saved.id, jpegData: photoData, petName: saved.name, service: photoService)
                }
            } catch {
                // 回滚乐观插入
                pets.removeAll { $0.id == tempID }
                scheduleReminders()   // 回滚后重排：撤掉刚为该 pet 乐观排下的提醒，避免指向已不存在的记录
                SWAlertManager.shared.show(.error, message: "Failed to add \(pet.name): \(error.localizedDescription)")
            }
        }
    }

    /// 首次上传照片（创建宠物流程内部用）并把后端返回的 photoPath 写回对应 pet。
    /// pet 本身已创建成功，照片上传失败不回滚 pet，只大声暴露——头像退回 emoji 兜底，用户可稍后补图。
    private func uploadPhoto(petID: UUID, jpegData: Data, petName: String, service: PhotoService) async {
        do {
            let (photoPath, _) = try await service.upload(petId: petID, jpegData: jpegData)
            applyUploadedPhoto(petID: petID, photoPath: photoPath, jpegData: jpegData, isReplacement: false)
        } catch {
            SWAlertManager.shared.show(.error, message: "\(petName)'s photo failed to upload: \(error.localizedDescription)")
        }
    }

    /// 详情页「更改 / 补充头像」：上传新图 → 回写 photoAssetName → 刷新缓存与 UI。
    /// network 模式专用；mock 模式或无 photoService 直接抛错由调用方兜。
    /// 成功后 PPPetAvatar 通过 photoVersion 自增触发重载，命中刚存入的新缓存（无闪）。
    func replacePhoto(petID: UUID, jpegData: Data) async throws {
        guard dataSource == .network, let photoService else {
            throw APIError.invalidURL   // 非网络模式没有上传端点，调用方不会走到这（详情页换图仅 network 出现）
        }
        let (photoPath, _) = try await photoService.upload(petId: petID, jpegData: jpegData)
        applyUploadedPhoto(petID: petID, photoPath: photoPath, jpegData: jpegData, isReplacement: true)
    }

    /// Home 沉浸页「换背景」：上传新图 → 回写 backgroundAssetName → 刷新缓存与 UI。
    /// network 模式专用；mock 模式或无 photoService 抛错，由调用方降级本地缓存。
    /// 成功后背景层通过 backgroundVersion 自增触发重载，命中刚存入的新缓存（无闪）。
    func replaceBackground(petID: UUID, jpegData: Data) async throws {
        guard dataSource == .network, let photoService else {
            throw APIError.invalidURL   // 非网络模式没有上传端点，调用方降级走本地 ImageCache
        }
        let (backgroundPath, _) = try await photoService.uploadBackground(petId: petID, jpegData: jpegData)

        // 回写 + 缓存收尾（与头像 applyUploadedPhoto 同套路，upsert 覆盖后 path 不变靠版本号驱动重载）
        if let idx = pets.firstIndex(where: { $0.id == petID }) {
            pets[idx].backgroundAssetName = backgroundPath
        }
        invalidateSignedURL(forPath: backgroundPath)
        ImageCache.shared.remove(forKey: backgroundPath)
        if let image = UIImage(data: jpegData) {
            ImageCache.shared.store(image, forKey: backgroundPath)
        }
        backgroundVersion[petID, default: 0] += 1
    }

    /// 上传成功后的统一收尾：回写 photoAssetName + 刷新双层缓存 + 自增头像版本号。
    /// - isReplacement: true = 换图（path 可能不变，必须先失效旧 signed URL + 清旧图缓存再存新图）。
    private func applyUploadedPhoto(petID: UUID, photoPath: String, jpegData: Data, isReplacement: Bool) {
        // 1) 回写 object path（含 "/"）→ PPPetAvatar 据此走远程分支
        if let idx = pets.firstIndex(where: { $0.id == petID }) {
            pets[idx].photoAssetName = photoPath
        }
        // 2) 换图：upsert 覆盖后 path 不变，旧的 signed URL 与旧图缓存都要先失效，否则显示旧图
        if isReplacement {
            invalidateSignedURL(forPath: photoPath)
            ImageCache.shared.remove(forKey: photoPath)
        }
        // 3) 把刚上传的字节存入图片缓存（key = 稳定 photoPath）→ 下次首帧同步命中、无闪
        if let image = UIImage(data: jpegData) {
            ImageCache.shared.store(image, forKey: photoPath)
        }
        // 4) 自增版本号 → 驱动正在显示的 PPPetAvatar 重跑 .task 取新缓存
        photoVersion[petID, default: 0] += 1
    }

    /// 回填 / 编辑已存在的宠物（PALS 助手页数据回填用）。
    /// 按 id 原地替换，触发 @Observable 刷新 → 依赖该 pet 的 view（首页待办 / 本页 checklist）自动更新。
    /// 网络模式：本地先改（即时刷新）→ 后台 PATCH，成功用后端行回填；失败回滚到旧值并 SWAlert 报错。
    func updatePet(_ pet: Pet) {
        guard let idx = pets.firstIndex(where: { $0.id == pet.id }) else { return }
        let previous = pets[idx]   // 保存旧值用于失败回滚
        pets[idx] = pet
        scheduleReminders()   // 牌照到期日 / 绝育状态可能变 → 重排

        guard dataSource == .network, let petService else { return }

        Task { @MainActor in
            do {
                let saved = try await petService.update(pet)
                if let i = pets.firstIndex(where: { $0.id == saved.id }) {
                    pets[i] = saved
                }
            } catch {
                if let i = pets.firstIndex(where: { $0.id == previous.id }) {
                    pets[i] = previous   // 回滚
                }
                scheduleReminders()   // 回滚后重排：牌照到期日 / 绝育状态还原了，提醒也要跟着还原
                SWAlertManager.shared.show(.error, message: "Failed to update \(pet.name): \(error.localizedDescription)")
            }
        }
    }

    /// 删除宠物。同步签名：本地立即移除 → UI 即时刷新。
    /// 网络模式：后台 DELETE；失败把宠物加回并 SWAlert 报错。
    /// （当前 M1 无删除 UI 入口，提供此方法以满足契约 + 备后续接入。）
    func removePet(id: UUID) {
        guard let idx = pets.firstIndex(where: { $0.id == id }) else { return }
        let removed = pets.remove(at: idx)
        scheduleReminders()

        guard dataSource == .network, let petService else { return }

        Task { @MainActor in
            do {
                try await petService.delete(id: id)
            } catch {
                pets.append(removed)   // 回滚
                scheduleReminders()   // 回滚后重排：pet 被加回来了，它的到期提醒也要恢复
                SWAlertManager.shared.show(.error, message: "Failed to delete \(removed.name): \(error.localizedDescription)")
            }
        }
    }

    // MARK: - 健康记录写操作（4 类，乐观更新 + 后台同步 + 失败回滚 + SWAlert）
    //
    // 用一个泛型 helper 收敛 create / update / delete 的乐观更新样板（避免 12 个方法各抄一遍），
    // 4 类的数组用 ReferenceWritableKeyPath 定位，网络调用经闭包注入（各 record 类型对应不同 Service 方法）。
    // mock 模式：仅改本地内存，不触网（行为与原 addVaccination/addWeightRecord 一致）。
    // 同步签名：现有 View 调用点（AddVaccinationSheet / AddWeightSheet）一行不改。

    /// create：本地立即 append（UI 即时刷新）→ network 后台 POST，成功用后端真实行替换、失败回滚。
    private func optimisticCreate<T: HealthRecordType>(
        _ record: T,
        keyPath: ReferenceWritableKeyPath<PetBookStore, [T]>,
        remote: @escaping (HealthRecordService, T) async throws -> T,
        failLabel: String
    ) {
        self[keyPath: keyPath].append(record)
        scheduleReminders()   // 健康记录变 → 重排提醒
        guard dataSource == .network, let healthService else { return }

        let tempID = record.id
        Task { @MainActor in
            do {
                let saved = try await remote(healthService, record)
                if let idx = self[keyPath: keyPath].firstIndex(where: { $0.id == tempID }) {
                    self[keyPath: keyPath][idx] = saved   // 真实 id / server 字段回填
                }
            } catch {
                self[keyPath: keyPath].removeAll { $0.id == tempID }   // 回滚
                scheduleReminders()   // 回滚后重排：撤掉刚为该记录乐观排下的提醒
                SWAlertManager.shared.show(.error, message: "Failed to add \(failLabel): \(error.localizedDescription)")
            }
        }
    }

    /// update：本地原地替换（即时刷新）→ network 后台 PATCH，成功用后端行回填、失败回滚到旧值。
    private func optimisticUpdate<T: HealthRecordType>(
        _ record: T,
        keyPath: ReferenceWritableKeyPath<PetBookStore, [T]>,
        remote: @escaping (HealthRecordService, T) async throws -> T,
        failLabel: String
    ) {
        guard let idx = self[keyPath: keyPath].firstIndex(where: { $0.id == record.id }) else { return }
        let previous = self[keyPath: keyPath][idx]
        self[keyPath: keyPath][idx] = record
        scheduleReminders()   // 健康记录变 → 重排提醒

        guard dataSource == .network, let healthService else { return }

        Task { @MainActor in
            do {
                let saved = try await remote(healthService, record)
                if let i = self[keyPath: keyPath].firstIndex(where: { $0.id == saved.id }) {
                    self[keyPath: keyPath][i] = saved
                }
            } catch {
                if let i = self[keyPath: keyPath].firstIndex(where: { $0.id == previous.id }) {
                    self[keyPath: keyPath][i] = previous   // 回滚
                }
                scheduleReminders()   // 回滚后重排：到期日等还原了，提醒也要跟着还原
                SWAlertManager.shared.show(.error, message: "Failed to update \(failLabel): \(error.localizedDescription)")
            }
        }
    }

    /// delete：本地立即移除（即时刷新）→ network 后台 DELETE，失败把记录加回。
    private func optimisticDelete<T: HealthRecordType>(
        id: UUID,
        keyPath: ReferenceWritableKeyPath<PetBookStore, [T]>,
        remote: @escaping (HealthRecordService, UUID) async throws -> String,
        failLabel: String
    ) {
        guard let idx = self[keyPath: keyPath].firstIndex(where: { $0.id == id }) else { return }
        let removed = self[keyPath: keyPath].remove(at: idx)
        scheduleReminders()   // 健康记录变 → 重排提醒

        guard dataSource == .network, let healthService else { return }

        Task { @MainActor in
            do {
                _ = try await remote(healthService, id)
            } catch {
                self[keyPath: keyPath].append(removed)   // 回滚
                scheduleReminders()   // 回滚后重排：记录被加回来了，它的到期提醒也要恢复
                SWAlertManager.shared.show(.error, message: "Failed to delete \(failLabel): \(error.localizedDescription)")
            }
        }
    }

    // --- 疫苗 ---
    /// 新增疫苗记录（保留原方法名，AddVaccinationSheet 调用点不变）。
    func addVaccination(_ record: VaccinationRecord) {
        optimisticCreate(record, keyPath: \.vaccinations,
                         remote: { try await $0.createVaccination(petID: record.petID, $1) },
                         failLabel: "vaccine")
    }
    func updateVaccination(_ record: VaccinationRecord) {
        optimisticUpdate(record, keyPath: \.vaccinations,
                         remote: { try await $0.updateVaccination(petID: record.petID, $1) },
                         failLabel: "vaccine")
    }
    func deleteVaccination(_ record: VaccinationRecord) {
        optimisticDelete(id: record.id, keyPath: \.vaccinations,
                         remote: { try await $0.deleteVaccination(petID: record.petID, id: $1) },
                         failLabel: "vaccine")
    }

    // --- 驱虫 ---
    func addDeworming(_ record: DewormingRecord) {
        optimisticCreate(record, keyPath: \.dewormings,
                         remote: { try await $0.createDeworming(petID: record.petID, $1) },
                         failLabel: "deworming")
    }
    func updateDeworming(_ record: DewormingRecord) {
        optimisticUpdate(record, keyPath: \.dewormings,
                         remote: { try await $0.updateDeworming(petID: record.petID, $1) },
                         failLabel: "deworming")
    }
    func deleteDeworming(_ record: DewormingRecord) {
        optimisticDelete(id: record.id, keyPath: \.dewormings,
                         remote: { try await $0.deleteDeworming(petID: record.petID, id: $1) },
                         failLabel: "deworming")
    }

    // --- 就诊 ---
    func addVetVisit(_ record: VetVisitRecord) {
        optimisticCreate(record, keyPath: \.vetVisits,
                         remote: { try await $0.createVetVisit(petID: record.petID, $1) },
                         failLabel: "vet visit")
    }
    func updateVetVisit(_ record: VetVisitRecord) {
        optimisticUpdate(record, keyPath: \.vetVisits,
                         remote: { try await $0.updateVetVisit(petID: record.petID, $1) },
                         failLabel: "vet visit")
    }
    func deleteVetVisit(_ record: VetVisitRecord) {
        optimisticDelete(id: record.id, keyPath: \.vetVisits,
                         remote: { try await $0.deleteVetVisit(petID: record.petID, id: $1) },
                         failLabel: "vet visit")
    }

    // --- 体重 ---
    /// 新增体重记录（保留原方法名，AddWeightSheet 调用点不变）。
    func addWeightRecord(_ record: WeightRecord) {
        optimisticCreate(record, keyPath: \.weights,
                         remote: { try await $0.createWeight(petID: record.petID, $1) },
                         failLabel: "weight")
    }
    func updateWeightRecord(_ record: WeightRecord) {
        optimisticUpdate(record, keyPath: \.weights,
                         remote: { try await $0.updateWeight(petID: record.petID, $1) },
                         failLabel: "weight")
    }
    func deleteWeightRecord(_ record: WeightRecord) {
        optimisticDelete(id: record.id, keyPath: \.weights,
                         remote: { try await $0.deleteWeight(petID: record.petID, id: $1) },
                         failLabel: "weight")
    }

    func clinicService(id: String) -> ClinicService? {
        clinicServices.first { $0.id == id }
    }

    func appointment(id: UUID) -> Appointment? {
        appointments.first { $0.id == id }
    }

    func vet(id: UUID?) -> Vet? {
        guard let id else { return nil }
        return vets.first { $0.id == id }
    }

    func vets(of clinicID: UUID) -> [Vet] {
        vets.filter { $0.clinicID == clinicID }
    }

    /// 某医生某天的全部 1 小时可预约时段；非工作日返回 []。
    /// isTaken = 同医生同时段已有未取消的预约（含 mock 预置占用），下单时置灰禁用。
    func slots(forVet vetID: UUID, on day: Date) -> [TimeSlot] {
        guard let vet = vet(id: vetID) else { return [] }
        let cal = Calendar.current
        let weekday = cal.component(.weekday, from: day)
        guard vet.workingWeekdays.contains(weekday) else { return [] }

        let startOfDay = cal.startOfDay(for: day)
        return (vet.startHour..<vet.endHour).compactMap { hour in
            guard let slotStart = cal.date(byAdding: .hour, value: hour, to: startOfDay) else { return nil }
            let bookedByOthers = vet.bookedSlots.contains {
                cal.isDate($0, equalTo: slotStart, toGranularity: .hour)
            }
            let bookedByUser = appointments.contains { appt in
                appt.vetID == vetID
                    && appt.status != .cancelled
                    && cal.isDate(appt.scheduledDate, equalTo: slotStart, toGranularity: .hour)
            }
            return TimeSlot(start: slotStart, isTaken: bookedByOthers || bookedByUser)
        }
    }

    /// "Any vet"：诊所全部医生当天时段的并集；某时段只要有任一医生空闲即可约。
    func slots(forClinic clinicID: UUID, on day: Date) -> [TimeSlot] {
        var hasFreeVet: [Date: Bool] = [:]
        for vet in vets(of: clinicID) {
            for slot in slots(forVet: vet.id, on: day) {
                hasFreeVet[slot.start] = (hasFreeVet[slot.start] ?? false) || !slot.isTaken
            }
        }
        return hasFreeVet.keys.sorted().map { TimeSlot(start: $0, isTaken: !(hasFreeVet[$0] ?? false)) }
    }

    /// 提交预约请求（Requested），demo 用计时器模拟诊所约 4 秒后确认（→ Confirmed），跑通收单闭环。
    @discardableResult
    func requestAppointment(clinicID: UUID, serviceID: String, vetID: UUID?, petID: UUID?,
                            scheduledDate: Date, reason: String?, isNewPatient: Bool) -> Appointment {
        let appt = Appointment(
            reference: Self.makeReference(),
            clinicID: clinicID,
            serviceID: serviceID,
            vetID: vetID,
            petID: petID,
            scheduledDate: scheduledDate,
            reason: reason,
            isNewPatient: isNewPatient,
            status: .requested
        )
        appointments.append(appt)
        scheduleAutoConfirm(appt.id)
        return appt
    }

    /// demo-only：模拟诊所前台确认——约 4 秒后把仍处于 Requested 的预约转 Confirmed。
    private func scheduleAutoConfirm(_ id: UUID) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(4))
            if let idx = appointments.firstIndex(where: { $0.id == id }),
               appointments[idx].status == .requested {
                appointments[idx].status = .confirmed
            }
        }
    }

    func cancelAppointment(_ id: UUID) {
        if let idx = appointments.firstIndex(where: { $0.id == id }) {
            appointments[idx].status = .cancelled
        }
    }

    /// 生成展示用预约号，如 "PP-7K3M"（去掉易混淆的 0/O/1/I）。
    private static func makeReference() -> String {
        let chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "PP-" + String((0..<4).map { _ in chars.randomElement()! })
    }

}

// MARK: - HealthRecordType（4 类健康记录的共同抽象，供 Store 泛型乐观更新 helper 用）

/// 4 类健康记录都满足：UUID 主键 + 归属某 pet。helper 据此定位本地数组里的记录。
/// 仅作 Store 内部泛型约束用，不暴露业务语义；conformance 是空的（字段已存在）。
protocol HealthRecordType: Identifiable where ID == UUID {
    var petID: UUID { get }
}

extension VaccinationRecord: HealthRecordType {}
extension DewormingRecord: HealthRecordType {}
extension VetVisitRecord: HealthRecordType {}
extension WeightRecord: HealthRecordType {}
