//
//  RootView.swift
//  PetBook
//
//  顶层视图：OnboardingFlow ↔ RootTabView 切换。
//  持久化 flag 与 UI 切换分离（P2 庆祝屏引入）：
//    • UI 由进程内锁存 @State showOnboarding 驱动（初值取自持久化 flag）；
//    • OnboardingFlow.submit() 建 pet 成功后立即把 flag 落盘 —— 防庆祝屏停留期间进程被杀 →
//      重开重走 onboarding → 服务端重复建宠物；若 UI 直接跟 flag，落盘瞬间庆祝屏会被销毁，
//      故切换时机始终由 onCompleted 回调驱动。
//

import SwiftUI

struct RootView: View {
    /// UserDefaults key（本文件锁存初值 + OnboardingFlow 提前落盘 共用，勿散落字符串）。
    static let onboardingFlagKey = "hasCompletedOnboarding"

    @AppStorage(RootView.onboardingFlagKey) private var hasCompletedOnboarding: Bool = false

    /// 进程内 UI 锁存：本次启动展示哪棵树，只在 onCompleted 回调时翻转。
    @State private var showOnboarding: Bool

    init() {
        // @AppStorage 在 init 阶段尚不可读，直接读同 key 的 UserDefaults 取锁存初值
        _showOnboarding = State(initialValue: !UserDefaults.standard.bool(forKey: RootView.onboardingFlagKey))
    }

    var body: some View {
        Group {
            if showOnboarding {
                OnboardingFlow {
                    hasCompletedOnboarding = true   // 正常路径兜底落盘（submit 已提前落，幂等）
                    withAnimation(.easeInOut(duration: 0.3)) {
                        showOnboarding = false
                    }
                }
            } else {
                RootTabView()
            }
        }
    }
}

#Preview {
    RootView()
        .environment(PetBookStore())
}
