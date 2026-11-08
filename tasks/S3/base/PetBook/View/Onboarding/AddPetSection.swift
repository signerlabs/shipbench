//
//  AddPetSection.swift
//  PetBook
//
//  Onboarding 屏 2：输入名字 + 选品种（可选）。极简两字段，15 秒完成。
//  起名仪式感（设计语言 v2 · P2）：顶部延续屏 1 所选物种的视频小卡建立两屏连续感；
//  名字用大号居中输入 + 焦点下划线；输入后标题实时变 "Tell us about Mochi"。
//  品种选择复用 PPSearchablePicker，狗选中后展示实时 HDB 合规反馈。
//  绝育、DOB、照片等信息由 Home 的 Profile Completion 引导卡逐步收集。
//

import SwiftUI

struct AddPetSection: View {
    @Bindable var state: OnboardingState
    let onBack: () -> Void
    let onContinue: () -> Void

    @FocusState private var nameIsFocused: Bool

    private var isDog: Bool { state.species == .dog }

    private var speciesNoun: String { state.species == .cat ? "cat" : "dog" }

    /// 标题里实时回显的名字（去首尾空格；空则退物种称呼）
    private var trimmedName: String {
        state.petName.trimmingCharacters(in: .whitespaces)
    }

    private var dogComplianceStatus: HDBComplianceStatus? {
        guard isDog, !state.petBreed.isEmpty else { return nil }
        return BreedCatalog.dogStatus(for: state.petBreed)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: PPSpacing.xl) {
                Spacer(minLength: PPSpacing.xxl)

                // 屏 1 所选物种的视频小卡延续（同资源、同物种色描边），建立两屏连续感
                PPVideoView(resourceName: state.species == .cat ? "CatVideo" : "DogVideo")
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                            .strokeBorder((isDog ? Color.ppDog : Color.ppCat).opacity(0.6), lineWidth: 2)
                    )

                VStack(spacing: PPSpacing.sm) {
                    // 名字非空时标题实时变 "Tell us about Mochi"（起名即被称呼，仪式感所在）
                    Text(trimmedName.isEmpty ? "Tell us about your \(speciesNoun)" : "Tell us about \(trimmedName)")
                        .font(.title2)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.center)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.2), value: trimmedName.isEmpty)

                    Text("You can add more details later.")
                        .font(.subheadline)
                        .foregroundStyle(Color.ppTextSecondary)
                }

                // 名字：大号居中输入 + 焦点下划线（起名是本屏的主角，不收进表单小字段）
                VStack(spacing: PPSpacing.sm) {
                    TextField("Name, e.g. Mochi", text: $state.petName)
                        .font(.title2)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.center)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .focused($nameIsFocused)
                        .padding(.vertical, PPSpacing.sm)

                    Capsule()
                        .fill(nameIsFocused ? Color.ppPrimary : Color.ppBorder)
                        .frame(width: 160, height: 2)
                        .animation(.easeInOut(duration: 0.2), value: nameIsFocused)
                }

                // 品种
                PPLabeledField(
                    label: "Breed",
                    hint: isDog ? "Used for HDB compliance check" : nil
                ) {
                    PPSearchablePicker(
                        placeholder: "Select breed",
                        sheetTitle: isDog ? "Select Dog Breed" : "Select Cat Breed",
                        searchPrompt: "Search breeds",
                        selection: $state.petBreed,
                        options: isDog ? BreedCatalog.dogBreedNames : BreedCatalog.catBreeds
                    ) { name in
                        if isDog, let status = BreedCatalog.dogStatus(for: name) {
                            HDBComplianceBadge(status: status)
                        }
                    }
                }

                if let status = dogComplianceStatus {
                    HDBComplianceFeedbackBanner(status: status)
                }

                Spacer(minLength: 120)
            }
            .padding(.horizontal, PPSpacing.xl)
        }
        .scrollDismissesKeyboard(.immediately)
        .overlay(alignment: .bottom) {
            VStack {
                PPPrimaryButton(
                    title: "Continue",
                    systemImage: "arrow.right",
                    enabled: state.canProceedFromInfo
                ) {
                    onContinue()
                }
                .padding(.horizontal, PPSpacing.xl)
                .padding(.bottom, PPSpacing.xl)
            }
            .background(
                LinearGradient(
                    colors: [Color.ppBackground.opacity(0), Color.ppBackground],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 120)
                .allowsHitTesting(false),
                alignment: .bottom
            )
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { onBack() } label: {
                    Image(systemName: "chevron.left")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                }
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                nameIsFocused = true
            }
        }
    }
}

#Preview("Dog") {
    NavigationStack {
        AddPetSection(state: {
            let s = OnboardingState()
            s.species = .dog
            return s
        }(), onBack: {}, onContinue: {})
    }
    .environment(PetBookStore())
}

#Preview("Cat") {
    NavigationStack {
        AddPetSection(state: {
            let s = OnboardingState()
            s.species = .cat
            return s
        }(), onBack: {}, onContinue: {})
    }
    .environment(PetBookStore())
}
