//
//  ReminderScheduler.swift
//  PetBook
//
//  本地通知提醒系统（F3.x）。两块：
//    • ReminderPlanner — 纯逻辑：把 HomeReminder（已算好到期日）按「提醒本质」展开成
//      未来要触发的通知条目（每条到期事项 × 该类型的提前量 offset）。
//      调度层与展示层（NotificationsView）共用它，保证「会弹的通知」=「列表里看到的」。
//    • ReminderScheduler — 包 UNUserNotificationCenter：幂等重排（removeAll → 全量注册
//      UNCalendarNotificationTrigger）+ 权限查询。
//
//  策略（按本质定提前量，产品负责人 2026-05-31 拍板）：
//    证照续期 30/7/1/当天（逾期违法，最密）· 疫苗 7/1 · 驱虫 7/1 · 复诊 3/1 · 生日当天。
//  触发时刻：到期日当天上午 09:00，本地时区（DateComponents 不设 timeZone → 跟随系统）。
//

import Foundation
import UserNotifications

// MARK: - 单条已展开的提醒（= 一条未来系统通知 / 一行 NotificationsView）

struct ScheduledReminder: Identifiable {
    /// 同时作为 UNNotificationRequest 的 identifier（稳定、同批不冲突）。
    let id: String
    let kind: HomeReminder.Kind
    let pet: Pet
    let fireDate: Date     // 实际触发时刻（到期日 - offset 天，09:00 本地）
    let dueDate: Date      // 原到期日
    let offsetDays: Int    // 提前天数（0 = 到期当天）
    let title: String      // 通知标题（复用 HomeReminder.title）
    let body: String       // 通知正文（含宠物名 + 倒计时 + 行动提示）
}

// MARK: - 规划器（纯逻辑，无副作用，可单测）

enum ReminderPlanner {

    /// 统一触发时刻：上午 9 点（本地时区）。
    static let fireHour = 9

    /// iOS 单 app 最多 64 条 pending 本地通知；超出按 fireDate 取最近的若干条。
    static let maxScheduled = 64

    /// 按提醒类型的本质给出提前量（天）。空数组 = 不调度（如阶段二的到店预约）。
    static func offsets(for kind: HomeReminder.Kind) -> [Int] {
        switch kind {
        case .licenseExpiry:  [30, 7, 1, 0]   // 续牌耗时 + 逾期违法 → 最密 + 到期当天兜底
        case .vaccine:        [7, 1]
        case .deworming:      [7, 1]
        case .vetFollowUp:    [3, 1]
        case .birthday:       [0]              // 生日当天一条庆祝提醒
        case .vetAppointment: []              // 阶段二能力，本地通知不调度
        }
    }

    /// 已进入提醒窗口的事项：到期日落在该类型最大提前量之内（系统已 / 即将开始提醒它）。
    /// NotificationsView 列表 + 铃铛红点共用，保证「红点亮 = 点进去有内容」；还很远的待办不算。
    static func active(_ reminders: [HomeReminder]) -> [HomeReminder] {
        reminders.filter { r in
            guard let maxOffset = offsets(for: r.kind).max() else { return false }
            return HomeFeed.daysUntil(r.date) <= maxOffset
        }
    }

    /// 把到期事项展开成「未来要触发的通知条目」，按触发时间升序；只保留 now 之后的。
    /// - now 显式注入便于测试 / 复用同一基准。
    static func plan(reminders: [HomeReminder], now: Date = Date()) -> [ScheduledReminder] {
        let cal = Calendar.current
        var out: [ScheduledReminder] = []

        for r in reminders {
            for off in offsets(for: r.kind) {
                // 触发日 = 到期日 - off 天；时刻拨到当天 09:00（本地时区）
                guard let shifted = cal.date(byAdding: .day, value: -off, to: r.date) else { continue }
                var comps = cal.dateComponents([.year, .month, .day], from: shifted)
                comps.hour = fireHour
                comps.minute = 0
                guard var fireDate = cal.date(from: comps) else { continue }
                // 触发时刻已过：今天但过了 09:00 → 补发（稍后立即弹一次）；真正过去的日子（昨天及更早）才跳过。
                // 适用所有类型：当天才设的生日 / 当天到期的证照 / 当天到期的疫苗等都不漏。
                if fireDate < now {
                    guard cal.isDateInToday(fireDate) else { continue }
                    fireDate = now.addingTimeInterval(10)
                }

                let dueEpoch = Int(r.date.timeIntervalSince1970)
                out.append(ScheduledReminder(
                    // 折入 sourceID（底层记录判别符）：同宠同类型同到期日的多条记录（如同日两支疫苗）
                    // 由它区分，保证通知 id 永不相同、不会互相覆盖（后者覆盖前者导致静默丢失）。
                    id: "reminder.\(r.kind).\(r.pet.id.uuidString).\(r.sourceID.uuidString).\(dueEpoch).\(off)",
                    kind: r.kind,
                    pet: r.pet,
                    fireDate: fireDate,
                    dueDate: r.date,
                    offsetDays: off,
                    title: r.title,
                    body: bodyText(name: r.pet.name, kind: r.kind, offset: off)
                ))
            }
        }
        return out.sorted { $0.fireDate < $1.fireDate }
    }

    /// 通知正文：宠物名 + 倒计时 + 按类型的行动提示。
    static func bodyText(name: String, kind: HomeReminder.Kind, offset: Int) -> String {
        if kind == .birthday {
            return "Happy birthday to \(name)! 🎂"
        }
        let when: String
        switch offset {
        case ..<0: when = "is overdue"
        case 0:    when = "is due today"
        case 1:    when = "is due tomorrow"
        default:   when = "is due in \(offset) days"
        }
        let hint = actionHint(for: kind)
        return hint.isEmpty ? "\(name) \(when)." : "\(name) \(when). \(hint)"
    }

    private static func actionHint(for kind: HomeReminder.Kind) -> String {
        switch kind {
        case .licenseExpiry:  "Renew on PALS to stay compliant."
        case .vaccine:        "Book a vet visit."
        case .deworming:      "Time for the next dose."
        case .vetFollowUp:    "Vet recheck due."
        case .birthday:       ""
        case .vetAppointment: ""
        }
    }
}

// MARK: - 调度执行（UNUserNotificationCenter）

@MainActor
final class ReminderScheduler {
    static let shared = ReminderScheduler()
    private init() {}

    private let center = UNUserNotificationCenter.current()

    /// 幂等重排：清掉全部待发 → 按最新到期数据重建未来通知（仅已授权时真正注册）。
    /// 提醒条数少（单宠数条），全量重建最稳、不会漏删旧通知。
    func reschedule(reminders: [HomeReminder], now: Date = Date()) async {
        center.removeAllPendingNotificationRequests()

        // 未授权 / 已拒绝：不注册（系统也不会送达），NotificationsView 仍 app 内展示完整清单。
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional else { return }

        let plan = ReminderPlanner.plan(reminders: reminders, now: now)
        // 64 条系统上限：注册最近的若干条；NotificationsView 不受此限，仍显示全部。
        for item in plan.prefix(ReminderPlanner.maxScheduled) {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.sound = .default

            let comps = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: item.fireDate)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            let request = UNNotificationRequest(identifier: item.id, content: content, trigger: trigger)
            try? await center.add(request)
        }
    }

    /// 当前通知授权状态（NotificationsView 决定是否显示「去设置开启」引导）。
    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// 请求授权（onboarding 已请求；此处备用，如 NotificationsView 内再次引导）。
    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
    }
}
