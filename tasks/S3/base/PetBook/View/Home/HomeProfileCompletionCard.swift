import SwiftUI

/// Home 顶部的 Profile Completion 引导卡（设计语言 v2 · P3 收敛形态）：
/// 从 7 行全清单收敛为「进度环头像 + Next: 下一步 + n/N」单行卡 —— 一眼一个动作。
/// 点击进 ProfileCompletionFlow 七步流；hero 渐变底保留（它仍是首屏唯一焦点）。
struct HomeProfileCompletionCard: View {
    @Environment(PetBookStore.self) private var store

    let pet: Pet
    let pendingSteps: [ProfileCompletionStep]
    let onTap: () -> Void

    // POC 是 owner 级一次性资质：只在 owner 未完成时把该步骤计入 checklist（分母同步）。
    // owner 完成后此行从所有宠物卡片消失，与 pendingSteps 判定同源，保证「完成数/总数」始终一致。
    private var allSteps: [ProfileCompletionStep] {
        ProfileCompletionStep.allCases.filter { step in
            step != .setPOC || !store.owner.pocCompleted
        }
    }

    private var completedCount: Int {
        allSteps.count - pendingSteps.count
    }

    private var progress: Double {
        guard !allSteps.isEmpty else { return 1 }
        return Double(completedCount) / Double(allSteps.count)
    }

    /// 下一步 = pending 中优先级最高的一项（pendingSteps 按 allCases 顺序产出）。
    private var nextStep: ProfileCompletionStep? { pendingSteps.first }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: PPSpacing.lg) {
                // 头像 + 环形进度（完成度直接长在宠物身上）
                ZStack {
                    Circle()
                        .stroke(Color.ppPrimary.opacity(0.15), lineWidth: 4)
                    Circle()
                        .trim(from: 0, to: progress)
                        .stroke(Color.ppPrimary, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.spring(duration: 0.5), value: progress)
                    PPPetAvatar(pet: pet, size: 54)
                }
                .frame(width: 66, height: 66)

                VStack(alignment: .leading, spacing: PPSpacing.xs) {
                    Text("Set up \(pet.name)'s profile")
                        .font(.headline)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)
                        .lineLimit(1)

                    if let next = nextStep {
                        HStack(spacing: PPSpacing.xs) {
                            Text("Next:")
                                .foregroundStyle(Color.ppTextSecondary)
                            Text(stepLabel(next))
                                .fontWeight(.semibold)
                                .foregroundStyle(Color.ppPrimary)
                        }
                        .font(.subheadline)
                        .lineLimit(1)
                    }
                }

                Spacer(minLength: PPSpacing.sm)

                VStack(alignment: .trailing, spacing: PPSpacing.xs) {
                    Text("\(completedCount)/\(allSteps.count)")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(Color.ppTextSecondary)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextSecondary)
                }
            }
            .padding(PPSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                // Hero 卡：白底垫渐变（保证不透出米白背景）+ 主色软阴影，无描边（设计语言 v2）
                RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                    .fill(Color.ppSurface)
                    .overlay(
                        RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                            .fill(LinearGradient(
                                colors: [
                                    Color.ppPrimary.opacity(0.12),
                                    Color.ppPrimary.opacity(0.03)
                                ],
                                startPoint: .topTrailing,
                                endPoint: .bottomLeading
                            ))
                    )
                    .shadow(color: Color.ppPrimary.opacity(0.12), radius: 14, x: 0, y: 6)
            )
        }
        .buttonStyle(.ppPress)
    }

    private func stepLabel(_ step: ProfileCompletionStep) -> String {
        switch step {
        case .addPhoto:        "Add a photo"
        case .selectBreed:     "Select breed"
        case .setSterilized:   "Sterilization status"
        case .setPOC:          "Pet Ownership Course"
        case .setDateOfBirth:  "Date of birth"
        case .addFirstVaccine: "First vaccine record"
        case .enableReminders: "Enable reminders"
        }
    }
}

#Preview("Cat") {
    ScrollView {
        VStack(spacing: PPSpacing.md) {
            HomeProfileCompletionCard(
                pet: Pet.mocks[0],
                pendingSteps: ProfileCompletionStep.allCases
            ) {}
            HomeProfileCompletionCard(
                pet: Pet.mocks[0],
                pendingSteps: [.setDateOfBirth, .addFirstVaccine, .enableReminders]
            ) {}
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
    .environment(PetBookStore())
}

#Preview("Dog") {
    ScrollView {
        VStack(spacing: PPSpacing.md) {
            HomeProfileCompletionCard(
                pet: Pet.mocks[1],
                pendingSteps: [.addPhoto, .setSterilized, .setDateOfBirth, .addFirstVaccine, .enableReminders]
            ) {}
            HomeProfileCompletionCard(
                pet: Pet.mocks[1],
                pendingSteps: [.enableReminders]
            ) {}
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
    .environment(PetBookStore())
}
