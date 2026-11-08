//
//  NotificationsView.swift
//  PetBook
//
//  消息提醒中心 — 从一级页面右上角 bell 推入。
//  A1 模型（产品负责人 2026-05-31 定）：只显示「已进入提醒窗口」的到期事项 —— 即到期日落在该类型
//  最大提前量内（系统已经 / 即将开始提醒它），一事项一行。还很远的待办不放这里（那是首页
//  UPCOMING 时间线的全景）。倒计时相对今天 + 标注提前量。无「已读/未读」；权限未开时顶部引导。
//

import SwiftUI
import UserNotifications
import UIKit

struct NotificationsView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.openURL) private var openURL

    @State private var authStatus: UNAuthorizationStatus = .notDetermined

    /// 已进入提醒窗口的到期事项（一事项一行）；逻辑收在 `ReminderPlanner.active`，与铃铛红点同源。
    private var items: [HomeReminder] {
        ReminderPlanner.active(HomeFeed.upcomingReminders(store: store))
    }

    private var notificationsOff: Bool {
        authStatus == .denied || authStatus == .notDetermined
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PPSpacing.md) {
                if notificationsOff {
                    permissionBanner
                }

                if items.isEmpty {
                    emptyState
                } else {
                    ForEach(items) { item in
                        notificationRow(item)
                    }
                }
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.vertical, PPSpacing.lg)
        }
        .background(Color.ppBackground.ignoresSafeArea())
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            authStatus = await ReminderScheduler.shared.authorizationStatus()
        }
    }

    // MARK: - 空态

    private var emptyState: some View {
        VStack(spacing: PPSpacing.sm) {
            Image(systemName: "bell.badge")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Color.ppTextSecondary)
            Text("You're all caught up.")
                .font(.body)
                .foregroundStyle(Color.ppTextSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, PPSpacing.xxxl)
    }

    // MARK: - 未授权引导（notDetermined → 当场请求；denied → 跳系统设置）

    private var permissionBanner: some View {
        Button {
            handlePermissionTap()
        } label: {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: "bell.slash.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.ppPrimary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Notifications are off")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                    Text(authStatus == .notDetermined
                         ? "Tap to enable reminders for vaccines, licences and follow-ups."
                         : "Turn on in Settings to get reminders.")
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(Color.ppTextSecondary)
            }
            .padding(PPSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .fill(Color.ppPrimary.opacity(0.1))
            )
        }
        .buttonStyle(.ppPress)
    }

    private func handlePermissionTap() {
        if authStatus == .notDetermined {
            Task {
                _ = await ReminderScheduler.shared.requestAuthorization()
                authStatus = await ReminderScheduler.shared.authorizationStatus()
                store.scheduleReminders()   // 授权后立即排程
            }
        } else if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    // MARK: - 通知行

    private func notificationRow(_ item: HomeReminder) -> some View {
        // 紧急度三档配色与 Home 时间线同源（PPUrgency）；生日恒中性
        let urgency = PPUrgency(daysUntil: HomeFeed.daysUntil(item.date), muted: item.kind == .birthday)

        return HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(systemName: icon(for: item.kind))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(urgency.iconForeground)
                .frame(width: 36, height: 36)
                .background(Circle().fill(urgency.iconBackground))

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.headline)
                    .foregroundStyle(Color.ppTextPrimary)
                    .multilineTextAlignment(.leading)
                Text("\(item.pet.name) · \(dueText(item.date, kind: item.kind))")
                    .font(.footnote)
                    .foregroundStyle(urgency.accent)
                if !remindSchedule(item.kind).isEmpty {
                    Text(remindSchedule(item.kind))
                        .font(.caption)
                        .foregroundStyle(Color.ppTextSecondary)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(PPSpacing.md)
        .ppCard()
    }

    /// 相对今天的到期倒计时（含年份，避免远期歧义）。生日不说 "due"。
    private func dueText(_ date: Date, kind: HomeReminder.Kind) -> String {
        let d = HomeFeed.daysUntil(date)
        let dateStr = date.formatted(.dateTime.month(.abbreviated).day().year())
        if kind == .birthday {
            return (d <= 0 ? "today 🎂" : "in \(d) days") + " · \(dateStr)"
        }
        let when: String
        switch d {
        case ..<0: when = "overdue by \(abs(d)) days"
        case 0:    when = "due today"
        case 1:    when = "due tomorrow"
        default:   when = "due in \(d) days"
        }
        return "\(when) · \(dateStr)"
    }

    /// 该类型会提前几天提醒（取自 ReminderPlanner.offsets，与系统调度一致）。
    private func remindSchedule(_ kind: HomeReminder.Kind) -> String {
        let offs = ReminderPlanner.offsets(for: kind)
        let ahead = offs.filter { $0 > 0 }
        var parts: [String] = []
        if !ahead.isEmpty {
            parts.append(ahead.map(String.init).joined(separator: " / ") + " days before")
        }
        if offs.contains(0) { parts.append("on the day") }
        return parts.isEmpty ? "" : "Reminds you " + parts.joined(separator: " & ")
    }

    private func icon(for kind: HomeReminder.Kind) -> String {
        switch kind {
        case .vaccine:        "syringe"
        case .deworming:      "pills"
        case .licenseExpiry:  "doc.text"
        case .vetFollowUp:    "stethoscope"
        case .birthday:       "gift"
        case .vetAppointment: "calendar"
        }
    }
}

#Preview {
    NavigationStack { NotificationsView() }
        .environment(PetBookStore())
}
