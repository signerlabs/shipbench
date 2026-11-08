//
//  SpeciesSection.swift
//  PetBook
//
//  Onboarding 屏 1：物种二选一（猫 / 狗）。
//  放射性卡片转盘（参考别的项目的卡片转盘）：3 张卡片 [Cat · Welcome · Dog]
//  绕底部锚点旋转摆动，居中卡片正立，左右卡片向两侧摊开成扇形。
//  居中卡 = 当前选择（Welcome 居中 = 未选）。scrollPosition 双向绑定 state.species。
//

import SwiftUI

struct SpeciesSection: View {
    @Bindable var state: OnboardingState
    let onContinue: () -> Void
    /// Skip 行为由调用方注入：首次 onboarding → 不建宠物直接进主页；二次加宠物 → 关闭 fullScreenCover。
    let onSkip: () -> Void

    /// carousel 当前居中卡片（与 scrollPosition 双向绑定）
    @State private var centeredCard: SpeciesChoice? = .welcome

    /// welcome 卡入场摆动提示（false→true 触发一次 keyframe 衰减晃动）
    @State private var welcomeWiggle = false

    private static let cardWidth: CGFloat = 260
    private static let cardHeight: CGFloat = 380

    var body: some View {
        // NavigationStack 由父 OnboardingFlow 统一提供（屏 1 不需要返回按钮，隐藏 nav bar）
        VStack(spacing: 0) {
            titleBlock
                .padding(.top, PPSpacing.xxxl)
                .padding(.horizontal, PPSpacing.xl)

            Spacer(minLength: 0)

            carousel
                .frame(height: Self.cardHeight)

            Spacer()

            PPPrimaryButton(
                title: "Continue",
                systemImage: "arrow.right",
                enabled: state.canProceedFromSpecies
            ) {
                onContinue()
            }
            .padding(.horizontal, PPSpacing.xxxl)

            Button {
                onSkip()
            } label: {
                Text("Skip")
                    .font(.footnote)
                    .foregroundStyle(.ppTextSecondary)
            }
            .padding(.top)
            .padding(.bottom, PPSpacing.xl)
        }
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: centeredCard) {
            // 居中卡片即当前选择；Welcome 居中（或滑动中间态）= 未选
            state.species = centeredCard?.species
        }
    }

    // MARK: - 放射性卡片转盘

    private var carousel: some View {
        GeometryReader { proxy in
            let sideMargin = max(0, (proxy.size.width - Self.cardWidth) / 2)

            // ScrollViewReader 负责初始定位（iOS 17 scrollPosition 初始值不可靠，
            // 会停在第一张 cat），scrollPosition 负责读取用户滑动后的居中卡。
            ScrollViewReader { reader in
                ScrollView(.horizontal) {
                    HStack(spacing: -24) {
                        ForEach(SpeciesChoice.allCases) { choice in
                            card(for: choice)
                                .frame(width: Self.cardWidth, height: Self.cardHeight)
                                .id(choice)
                                .scrollTransition { content, phase in
                                    // phase.value：中心 0 / 左 -1 / 右 +1（连续）
                                    // 绕底部锚点旋转 ±12°，配合负 spacing 重叠成扇形放射
                                    content
                                        .opacity(phase.isIdentity ? 1 : 0.55)
                                        .scaleEffect(phase.isIdentity ? 1 : 0.86)
                                        .rotationEffect(.degrees(phase.value * 12), anchor: .bottom)
                                }
                                // welcome 卡入场摆动时浮到最上层，避免被相邻卡遮挡
                                .zIndex(choice == .welcome ? 1 : 0)
                                .padding(.bottom)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $centeredCard)
                .scrollIndicators(.hidden)
                .safeAreaPadding(.horizontal, sideMargin)
                .scrollDismissesKeyboard(.immediately)
                .onAppear {
                    // 下一 runloop（布局完成后）滚动到中间的 Welcome 卡并居中。
                    DispatchQueue.main.async {
                        reader.scrollTo(SpeciesChoice.welcome, anchor: .center)
                        centeredCard = .welcome
                    }
                }
            }
        }
    }

    // MARK: - 单张卡片

    /// 直接点击 Cat / Dog 卡片 = 选中该物种并继续（等同点 Continue）。
    private func selectAndContinue(_ species: Species) {
        state.species = species
        onContinue()
    }

    @ViewBuilder
    private func card(for choice: SpeciesChoice) -> some View {
        switch choice {
        case .cat:
            Button {
                selectAndContinue(.cat)
            } label: {
                videoCard(resource: "CatVideo", label: "Cat", accent: .ppCat)
            }
            .buttonStyle(.plain)
        case .welcome:
            welcomeCard
        case .dog:
            Button {
                selectAndContinue(.dog)
            } label: {
                videoCard(resource: "DogVideo", label: "Dog", accent: .ppDog)
            }
            .buttonStyle(.plain)
        }
    }

    private func videoCard(resource: String, label: String, accent: Color) -> some View {
        ZStack(alignment: .bottom) {
            PPVideoView(resourceName: resource)

            Text(label)
                .font(.title)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .foregroundStyle(.ultraThickMaterial)
                .padding(.bottom, PPSpacing.xl)
        }
        .clipShape(RoundedRectangle(cornerRadius: 32, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 32, style: .continuous)
                .strokeBorder(accent.opacity(0.6), lineWidth: 2)
        )
    }

    private var welcomeCard: some View {
        ZStack {
            // 动态流动渐变（iOS 18 MeshGradient / iOS 17 光斑 fallback），和谐暖色
            PPMeshBackground()

            VStack(spacing: PPSpacing.lg) {
                Image(.ppLogo)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 96)

                VStack(spacing: PPSpacing.md) {
                    Text("Choose your pet")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)

                    SwipeHint()
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 32, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 32, style: .continuous)
                .strokeBorder(Color.ppBorder, lineWidth: 1.5)
        )
        // 入场摆动提示「这里可以拖动」：绕底部锚点的衰减式旋转，上方摆幅大、下方钉住，
        // 模拟 carousel 转动；只在 welcomeWiggle 翻转时播一次
        .keyframeAnimator(initialValue: 0.0, trigger: welcomeWiggle) { view, angle in
            view.rotationEffect(.degrees(angle), anchor: .bottom)
        } keyframes: { _ in
            KeyframeTrack {
                SpringKeyframe(-5, duration: 0.18)
                SpringKeyframe(5, duration: 0.16)
                SpringKeyframe(-3, duration: 0.14)
                SpringKeyframe(3, duration: 0.14)
                SpringKeyframe(0, duration: 0.18)
            }
        }
        .onAppear {
            // 等 carousel 完成初始居中定位后再晃，避免和定位滚动叠加
            guard !welcomeWiggle else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                welcomeWiggle = true
            }
        }
    }

    // MARK: - 标题

    private var titleBlock: some View {
        VStack(spacing: 12) {
            Text("Welcome to PetBook")
                .font(.largeTitle)
                .fontWeight(.bold)
                .fontDesign(.rounded)
                .foregroundStyle(Color.ppTextPrimary)
                .multilineTextAlignment(.center)

            Text("Everything about your pet, in one place.")
                .font(.body)
                .foregroundStyle(Color.ppTextSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(2)
        }
    }
}

// MARK: - 卡片枚举

private enum SpeciesChoice: Int, CaseIterable, Identifiable {
    case cat, welcome, dog   // 顺序：左 Cat · 中 Welcome（默认居中）· 右 Dog
    var id: Int { rawValue }

    var species: Species? {
        switch self {
        case .cat: .cat
        case .welcome: nil
        case .dog: .dog
        }
    }
}

// MARK: - 滑动提示

private struct SwipeHint: View {
    var body: some View {
        HStack(spacing: 8) {
            // TimelineView 驱动旋转，每帧由 sin(time) 确定性计算 — 不走 SwiftUI
            // 隐式动画系统，避免 repeatForever 在父视图重布局时把图标"卷飞"。
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                Image(systemName: "hand.draw.fill")
                    .rotationEffect(.degrees(sin(t * 2.2) * 20 + 30))
            }
            Text("Swipe to choose")
        }
        .font(.subheadline)
        .foregroundStyle(Color.ppTextSecondary)
    }
}

#Preview {
    SpeciesSection(state: OnboardingState(), onContinue: {}, onSkip: {})
}
