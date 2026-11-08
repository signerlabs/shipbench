//
//  OnboardingFlow.swift
//  PetBook
//
//  Onboarding 总入口。极简 2 屏（物种 → 名字 → 提交 pet → 进 Home）。
//  品种、绝育、DOB 等详细信息由 Home 的 Profile Completion 引导卡逐步收集。
//

import SwiftUI

struct OnboardingFlow: View {
    @State private var state = OnboardingState()
    /// submit 成功创建的宠物，供第 3 屏 Celebration 展示（名字 + 头像）。
    @State private var createdPet: Pet?
    @Environment(PetBookStore.self) private var store
    let onCompleted: () -> Void

    var body: some View {
        // 单一 NavigationStack 包整个 onboarding：SWDots 放它内部最底层，三屏 content
        // 透明叠在其上 → SWDots 始终可见。
        NavigationStack {
            ZStack {
                SWDots(
                    style: .plasma,
                    tint: .ppTextSecondary,
                    background: .ppBackground
                )
                .opacity(0.4)
                .ignoresSafeArea()

                switch state.step {
                case .species:
                    SpeciesSection(state: state, onContinue: {
                        state.goToInfo()
                    }, onSkip: {
                        // 首次 onboarding skip：不建宠物，直接完成 onboarding 进主页
                        onCompleted()
                    })

                case .info:
                    AddPetSection(
                        state: state,
                        onBack: { state.goBackToSpecies() },
                        onContinue: { submit() }
                    )

                case .celebration:
                    // createdPet 只会在 submit 成功后进入本屏，nil 分支不可达（防御性留空）
                    if let pet = createdPet {
                        CelebrationSection(pet: pet, onDone: onCompleted)
                    }
                }
            }
        }
        .tint(Color.ppPrimary)
    }

    private func submit() {
        if let pet = state.makePet(ownerID: store.owner.id) {
            store.addPet(pet, photoData: nil, initialWeightKg: nil)
            // 宠物已建（network 模式立即落库）→ 立即持久化完成标记：
            // 防庆祝屏停留期间进程被杀 → 重开重走 onboarding → 服务端重复宠物。
            // UI 不会因此切走：RootView 由锁存 @State 驱动，flag 只做持久化（见 RootView 头注释）。
            UserDefaults.standard.set(true, forKey: RootView.onboardingFlagKey)
            createdPet = pet
            state.goToCelebration()   // 庆祝屏点按钮才 onCompleted()
        } else {
            onCompleted()
        }
    }
}

#Preview {
    OnboardingFlow(onCompleted: {})
        .environment(PetBookStore())
        .environment(LocationManager())
}
