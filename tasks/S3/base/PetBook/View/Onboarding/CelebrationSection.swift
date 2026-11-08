//
//  CelebrationSection.swift
//  PetBook
//
//  Onboarding / AddPetFlow 第 3 屏「Celebration」（设计语言 v2 · P2）：
//  宠物刚创建成功的奖赏时刻 —— confetti + 大头像 + "Mochi is all set!"。
//  同屏承担通知价值前置（B3）：未授权时展示模拟通知预览卡 + "Enable reminders" 软引导
//  （激动时刻转化最高；拒绝或稍后仍有 Profile Completion 七步流兜底）。
//  已授权（二次加宠物场景常见）则只显示 "Meet your dashboard" 直达按钮。
//

import SwiftUI
import UserNotifications

struct CelebrationSection: View {
    let pet: Pet
    /// 完成回调：onboarding → onCompleted()（进 Home）；AddPetFlow → dismiss()。
    let onDone: () -> Void

    @Environment(PetBookStore.self) private var store

    @State private var confetti = false
    /// 通知授权检查完成前不渲染按钮区，避免「软引导 ↔ 直达按钮」闪跳。
    @State private var checkedAuth = false
    @State private var notificationAuthorized = false
    /// 本屏已请求过一次权限（无论结果）：拒绝后按钮区退化为直达按钮，不纠缠。
    @State private var askedOnce = false

    private var showSoftAsk: Bool {
        checkedAuth && !notificationAuthorized && !askedOnce
    }

    var body: some View {
        VStack(spacing: PPSpacing.xl) {
            Spacer()

            PPPetAvatar(pet: pet, size: 120)

            VStack(spacing: PPSpacing.sm) {
                Text("\(pet.name) is all set!")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                    .multilineTextAlignment(.center)

                Text("Vaccines, licence and health records — \(pet.name)'s passport lives here now.")
                    .font(.body)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            // 按钮区：软引导（预览卡 + Enable + Maybe later）或直达按钮
            if showSoftAsk {
                VStack(spacing: PPSpacing.lg) {
                    PPNotificationPreviewCard(
                        message: "\(pet.name)'s rabies vaccine is due in 7 days"
                    )

                    Text("Never miss a vaccine or licence deadline")
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)

                    PPPrimaryButton(title: "Enable reminders", systemImage: "bell.fill") {
                        requestPermission()
                    }

                    Button {
                        onDone()
                    } label: {
                        Text("Maybe later")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                    }
                }
            } else if checkedAuth {
                PPPrimaryButton(title: "Meet your dashboard", systemImage: "arrow.right") {
                    onDone()
                }
            }
        }
        .padding(.horizontal, PPSpacing.xxl)
        .padding(.bottom, PPSpacing.xl)
        .toolbar(.hidden, for: .navigationBar)
        .swConfetti(isActive: $confetti, particleCount: 60, spread: .narrow, autoReset: true, centerOrigin: true)
        // 只在 confetti 翻 true 的上升沿震动：autoReset 3s 后会把 binding 翻回 false，
        // 无条件 trigger 会在下降沿凭空再震一次
        .sensoryFeedback(.success, trigger: confetti) { _, newValue in newValue }
        .task {
            notificationAuthorized = await ProfileCompletionFeed.checkNotificationAuthorization()
            checkedAuth = true
            // 稍等布局落定再撒花，落点在屏幕中央头像附近
            try? await Task.sleep(for: .milliseconds(350))
            confetti = true
        }
    }

    // MARK: - 通知软引导（notDetermined → 系统弹窗；denied 场景本屏不跳设置，交七步流兜底）

    private func requestPermission() {
        Task {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()

            switch settings.authorizationStatus {
            case .notDetermined:
                let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
                askedOnce = true
                notificationAuthorized = granted
                if granted {
                    store.scheduleReminders()   // 授权后立即排程
                    SWAlertManager.shared.show(.success, message: "Reminders enabled")
                    // 授权即完成本屏使命，顺滑直达 Home
                    try? await Task.sleep(for: .milliseconds(500))
                    onDone()
                } else {
                    SWAlertManager.shared.show(.info, message: "You can enable reminders later in Settings")
                }
            case .authorized, .provisional, .ephemeral:
                notificationAuthorized = true
                askedOnce = true
                onDone()
            case .denied:
                // 系统层已拒：庆祝屏不跳设置打断心流，退化为直达按钮（七步流会再引导）
                askedOnce = true
                SWAlertManager.shared.show(.info, message: "You can enable reminders later in Settings")
            @unknown default:
                askedOnce = true
            }
        }
    }
}

#Preview {
    NavigationStack {
        CelebrationSection(pet: Pet.mocks[0], onDone: {})
    }
    .environment(PetBookStore())
}
