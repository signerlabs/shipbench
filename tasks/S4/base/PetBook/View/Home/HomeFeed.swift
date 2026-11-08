//
//  HomeFeed.swift
//  PetBook
//
//  首页数据派生层（纯 Foundation 逻辑，不含 SwiftUI）。
//  从 PetBookStore 算出两类首页内容：
//    • HomeNextStep  — "今天最该做的单一动作"，状态机驱动，猫狗差异藏在优先级里。
//    • HomeReminder  — 即将到期事项的聚合时间线（疫苗 / 驱虫 / 复诊 / 牌照）。
//  展示信息（图标 / 颜色 / 文案）由 HomeView 侧映射，本层只产出结构化数据。
//

import Foundation

// MARK: - Next Step（首页唯一焦点动作）

struct HomeNextStep: Identifiable {
    enum Kind {
        case renewLicence        // 狗牌照即将 / 已过期（≤30 天）
        case completePOC         // owner 未完成 Pet Ownership Course（owner 级一次性，申牌前置，猫狗通用）
        case applyCatLicence     // 猫（owner POC 已完成）尚未申牌 → PALS 申请
        case registerDogLicence  // 狗尚未登记牌照
        case checkHDBOptions     // 住 HDB 且养了非 HDB 准养犬 → 看合规选项
        case bookHealth          // 疫苗 / 驱虫 / 复诊即将到期（≤14 天）
        case addFirstVaccine     // 还没有任何疫苗记录 → 补首条
    }

    let kind: Kind
    let pet: Pet
    var daysRemaining: Int? = nil   // 牌照 / 健康到期天数（负 = 已过期）
    var detailNoun: String? = nil   // bookHealth 时携带具体事项名（如 "Heartworm prevention"）
    var sourceKind: HomeReminder.Kind? = nil   // bookHealth 时携带来源（疫苗 / 驱虫），决定点击弹哪个录入 sheet
    /// 一只宠物同一时刻只产生一个 step，pet.id + kind 足以唯一（供 ForEach）。
    var id: String { "\(pet.id)-\(kind)" }
}

// MARK: - Reminder（即将到期时间线）

struct HomeReminder: Identifiable {
    enum Kind { case vaccine, deworming, licenseExpiry, vetFollowUp, vetAppointment, birthday }

    let id = UUID()
    let kind: Kind
    let pet: Pet
    /// 底层记录的稳定判别符（疫苗/驱虫/复诊/预约取各自记录 UUID；牌照/生日每宠唯一，取 pet.id）。
    /// 用于本地通知标识符去碰撞：同宠同类型同到期日的多条记录（如同日两支疫苗）靠它区分，
    /// 避免 ReminderScheduler 生成完全相同的通知 id 导致后者覆盖前者、只推一条。
    let sourceID: UUID
    let date: Date
    let title: String
    /// 仅 vetAppointment 携带，用于 UI 区分 Confirmed/Requested 配色；其他类型为 nil。
    var apptStatus: AppointmentStatus? = nil
}

// MARK: - Feed

enum HomeFeed {

    /// 新加坡猫只持牌过渡期截止日：2026-09-01 起无牌养猫即违法，此前为免费登记宽限期。
    /// 过了此日，applyCatLicence 文案从"免费登记倒计时"回退为常规合规催促。
    /// 来源：NParks Cat Management Framework（Animals and Birds Rules 2024，2024-09-01 生效，两年过渡期）。
    static let catLicensingDeadline: Date = {
        var c = DateComponents()
        c.year = 2026; c.month = 8; c.day = 31
        return Calendar.current.date(from: c) ?? Date()
    }()

    /// NextStep 大卡只收近期紧急动作（3 个月内有 deadline 的续牌——牌照可提前办）。
    /// UPCOMING 时间线则不限时间全列——产品负责人定：单宠用户着急的事做完后 NextStep 会空，
    /// UPCOMING 必须完整展示所有待办，否则首页太空。
    static let nextStepHorizonDays = 90

    /// 健康到期（疫苗 / 驱虫 / 复诊）的催办窗口，与续牌分开：疫苗没到期打不了，
    /// 提前一个半月催「Add record」用户无事可做；且补记录后 nextDue 顺延一个周期（常 ≤3 个月）
    /// 仍落在 90 天窗口内 → 待办永不消失（死循环）。收窄到 14 天（对齐 Kind.bookHealth 注释
    /// 与 ReminderScheduler 的 7/1 天提醒节奏）：进入窗口才催，补完记录顺延出窗口即消失。
    static let healthActionHorizonDays = 14

    /// 某宠物是否已有未结预约（Requested / Confirmed）。Next Step 去重用：
    /// 已约诊则不再催 bookHealth，避免与汇入时间线的预约条目重复提醒。
    static func hasOpenAppointment(for petID: UUID, store: PetBookStore) -> Bool {
        store.appointments.contains {
            $0.petID == petID && ($0.status == .requested || $0.status == .confirmed)
        }
    }

    /// 从今天 0 点到目标日 0 点的整天数（负 = 已过期）。
    static func daysUntil(_ date: Date) -> Int {
        let cal = Calendar.current
        return cal.dateComponents([.day],
                                  from: cal.startOfDay(for: Date()),
                                  to: cal.startOfDay(for: date)).day ?? 0
    }

    /// 从出生日期算下一个生日当天（今年的月/日，已过则取明年）。
    static func nextBirthday(from dob: Date) -> Date? {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let md = cal.dateComponents([.month, .day], from: dob)
        var comps = cal.dateComponents([.year], from: today)
        comps.month = md.month
        comps.day = md.day
        guard let thisYear = cal.date(from: comps) else { return nil }
        return thisYear >= today ? thisYear : cal.date(byAdding: .year, value: 1, to: thisYear)
    }

    /// 聚合所有宠物的全部到期事项（含已过期、含很久以后），按日期升序——不做时间窗口筛选。
    /// UPCOMING 时间线要完整：产品负责人定，单宠用户着急的事做完后只剩 UPCOMING，必须全列才不至于首页空。
    static func upcomingReminders(store: PetBookStore) -> [HomeReminder] {
        var out: [HomeReminder] = []

        for pet in store.pets {
            // 疫苗：每种类型只取「最新一次接种」的 next due —— 历史记录的 next due 已被后续续打作废，
            // 若每条都产提醒，打了新针旧的到期提醒也不消失（待办永远在）。同日多条以 next due 较晚者为准。
            let latestVax = Dictionary(grouping: store.vaccinations(of: pet.id), by: \.vaccineType)
                .values.compactMap { group -> VaccinationRecord? in
                    group.max { ($0.administeredDate, $0.nextDueDate ?? .distantPast)
                              < ($1.administeredDate, $1.nextDueDate ?? .distantPast) }
                }
            for v in latestVax {
                if let due = v.nextDueDate {
                    out.append(.init(kind: .vaccine, pet: pet, sourceID: v.id, date: due,
                                     title: "\(v.vaccineType.rawValue) vaccine"))
                }
            }
            // 驱虫：同理，每种 kind 只取最新一次接种的 next due
            let latestDeworm = Dictionary(grouping: store.dewormings(of: pet.id), by: \.kind)
                .values.compactMap { group -> DewormingRecord? in
                    group.max { ($0.administeredDate, $0.nextDueDate ?? .distantPast)
                              < ($1.administeredDate, $1.nextDueDate ?? .distantPast) }
                }
            for d in latestDeworm {
                if let due = d.nextDueDate {
                    let label = d.kind == .heartworm ? "Heartworm prevention"
                                                     : "\(d.kind.displayName) deworming"
                    out.append(.init(kind: .deworming, pet: pet, sourceID: d.id, date: due, title: label))
                }
            }
            for visit in store.vetVisits(of: pet.id) {
                if visit.followUpNeeded, let due = visit.followUpDate {
                    out.append(.init(kind: .vetFollowUp, pet: pet, sourceID: visit.id, date: due, title: "Vet recheck"))
                }
            }
            // 绝育宠物持终身牌（perpetual licence），无到期续期概念；即使误填了到期日也不列入提醒。
            if pet.sterilized != true, let exp = pet.avsLicenseExpiry {
                let noun = pet.species == .dog ? "Dog licence renewal" : "Cat licence renewal"
                out.append(.init(kind: .licenseExpiry, pet: pet, sourceID: pet.id, date: exp, title: noun))
            }
            // 生日（年度循环）：从 dob 算下一个生日当天
            if let dob = pet.dob, let next = nextBirthday(from: dob) {
                out.append(.init(kind: .birthday, pet: pet, sourceID: pet.id, date: next, title: "Birthday"))
            }
        }

        // 到店预约（仅未结的 Requested / Confirmed）汇入同一条时间线，与健康到期事项混排。
        // 字段只上：宠物名 + 服务名 + 时间 + 状态，管理细节（预约号 / 取消 / 医生）留 Orders。
        for appt in store.appointments {
            guard appt.status == .requested || appt.status == .confirmed,
                  let petID = appt.petID, let pet = store.pet(id: petID) else { continue }
            let serviceName = store.clinicService(id: appt.serviceID)?.name ?? "Vet appointment"
            out.append(.init(kind: .vetAppointment, pet: pet, sourceID: appt.id, date: appt.scheduledDate,
                             title: serviceName, apptStatus: appt.status))
        }

        // 不按时间筛选——全部待办都列出（含已过期与远期），仅按日期升序排。
        return out.sorted { $0.date < $1.date }
    }

    /// 每只宠物当前最该做的「下一步」，全部收集、按紧急度从上到下排。
    /// 与旧的「全局 top1」不同：per-pet 各算一个，让多宠 / 多待办都露出（产品负责人要求全展示）。
    /// 同一宠物内部仍按优先级取一个，避免显示矛盾动作（如未完成 POC 时不催申牌）。
    static func nextSteps(store: PetBookStore) -> [HomeNextStep] {
        var steps = store.pets.compactMap { nextStep(for: $0, store: store) }
        // POC 是 owner 级一次性资质（不分猫狗、不 per-pet）：owner 未完成时全局补「一条」待办，
        // 避免多宠物用户出现多条重复 POC。锚定首只宠物仅供卡片头像展示，语义与具体宠物无关。
        if !store.owner.pocCompleted, let anchor = store.pets.first {
            steps.append(.init(kind: .completePOC, pet: anchor))
        }
        return steps.sorted { rank($0.kind) < rank($1.kind) }
    }

    /// 单只宠物的下一步（per-pet 优先级，与原全局状态机同序）。
    private static func nextStep(for pet: Pet, store: PetBookStore) -> HomeNextStep? {
        // 通用最前：未绝育（周期牌）+ 牌照即将 / 已过期（3 个月内）→ 催续牌。
        // 猫狗同规（Animals and Birds Rules 2024）；绝育宠物持终身牌、无需续，故 sterilized==true 豁免。
        if pet.sterilized != true, let exp = pet.avsLicenseExpiry {
            let d = daysUntil(exp)
            if d <= nextStepHorizonDays { return .init(kind: .renewLicence, pet: pet, daysRemaining: d) }
        }

        if pet.species == .dog {
            // 尚未登记牌照
            if pet.avsLicenseID?.isEmpty ?? true {
                return .init(kind: .registerDogLicence, pet: pet)
            }
            // 住 HDB 且养了非 HDB 准养犬（也非 ADORE 路径）
            if store.owner.residenceType == .hdb,
               let breed = pet.breed,
               let status = BreedCatalog.dogStatus(for: breed),
               status != .hdbApproved, status != .adoreEligible {
                return .init(kind: .checkHDBOptions, pet: pet)
            }
        } else {
            // POC 是 owner 级前置，已移出 per-pet（见 nextSteps 全局产出一条）。
            // 未完成 POC 时不催申牌——申牌前置未满足，先引导完成课程；owner 完成 POC 后才催申牌。
            // POC 已完成、尚未申牌 → 带上过渡期倒计时天数（HomeNextStepCard 据此渲染 8/31 免费登记截止文案）
            if store.owner.pocCompleted, pet.avsLicenseID?.isEmpty ?? true {
                return .init(kind: .applyCatLicence, pet: pet,
                             daysRemaining: daysUntil(catLicensingDeadline))
            }
        }

        // 通用：健康到期（≤14 天，healthActionHorizonDays）催就诊；已有未结预约则静音（宁可漏催不可错催）。
        // 更远的到期归 UPCOMING 时间线展望，不作为「下一步行动」——避免补完记录顺延后仍在窗口内的死循环。
        if !hasOpenAppointment(for: pet.id, store: store) {
            let healthKinds: Set<HomeReminder.Kind> = [.vaccine, .deworming, .vetFollowUp]
            if let r = upcomingReminders(store: store).first(where: {
                $0.pet.id == pet.id && healthKinds.contains($0.kind)
                    && daysUntil($0.date) <= healthActionHorizonDays
            }) {
                return .init(kind: .bookHealth, pet: pet,
                             daysRemaining: daysUntil(r.date), detailNoun: r.title,
                             sourceKind: r.kind)
            }
        }

        // 通用：还没有任何疫苗记录
        if store.vaccinations(of: pet.id).isEmpty {
            return .init(kind: .addFirstVaccine, pet: pet)
        }

        return nil   // 该宠物全部安排妥当
    }

    /// 跨宠物排序权重：有 deadline / 合规里程碑的在上，补档案在下。
    private static func rank(_ kind: HomeNextStep.Kind) -> Int {
        switch kind {
        case .renewLicence:       0
        case .completePOC:        1
        case .applyCatLicence:    2
        case .registerDogLicence: 3
        case .checkHDBOptions:    4
        case .bookHealth:         5
        case .addFirstVaccine:    6
        }
    }
}
