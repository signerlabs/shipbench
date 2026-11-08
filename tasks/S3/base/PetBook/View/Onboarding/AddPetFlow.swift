//
//  AddPetFlow.swift
//  PetBook
//
//  首页「+ 添加宠物」入口：复用 onboarding 的物种选择 + 输入名字两屏。
//  以 fullScreenCover 弹出；名字填完即 makePet → store.addPet → dismiss。
//  与 OnboardingFlow 共用 OnboardingState / SpeciesSection / AddPetSection。
//

import SwiftUI

struct AddPetFlow: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var state = OnboardingState()
    /// submit 成功创建的宠物，供第 3 屏 Celebration 展示。
    @State private var createdPet: Pet?

    var body: some View {
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
                        // 二次加宠物 skip：等同关闭 fullScreenCover
                        dismiss()
                    })

                case .info:
                    AddPetSection(
                        state: state,
                        onBack: { state.goBackToSpecies() },
                        onContinue: { submit() }
                    )

                case .celebration:
                    if let pet = createdPet {
                        CelebrationSection(pet: pet, onDone: { dismiss() })
                    }
                }
            }
            .toolbar {
                // 右上角常驻关闭：前两屏可中途退出加宠物流程；庆祝屏不放 X（宠物已建成，
                // 唯一出口是庆祝屏自己的按钮，避免右上角干扰奖赏时刻）
                // （info 屏的左上返回由 AddPetSection 自带，与此处 trailing 不冲突）
                if state.step != .celebration {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.subheadline)
                                .fontWeight(.semibold)
                                .foregroundStyle(Color.ppTextSecondary)
                        }
                    }
                }
            }
        }
        .tint(Color.ppPrimary)
    }

    private func submit() {
        if let pet = state.makePet(ownerID: store.owner.id) {
            store.addPet(pet, photoData: nil, initialWeightKg: nil)
            createdPet = pet
            state.goToCelebration()   // 庆祝屏取代原 toast，出口在屏内按钮
        } else {
            dismiss()
        }
    }
}

#Preview {
    AddPetFlow()
        .environment(PetBookStore())
}
