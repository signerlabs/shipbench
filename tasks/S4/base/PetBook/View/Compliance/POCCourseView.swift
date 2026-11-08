//
//  POCCourseView.swift
//  PetBook
//
//  Pet Ownership Course（POC）课程详情页（二级 push 页，不挂 .ppShowsRootTabBar() → tab bar 自动隐藏）。
//  闭环设计（PRD F4.2）：用户从首页 completePOC 待办进来 →
//    ① 点「Start course」跳系统 Safari 看 AVS 官方在线课程（课程走 Singpass，系统浏览器体验最佳）；
//    ② 看完回来点「Mark as completed」→ owner.pocCompleted = true → completePOC 待办重算后自动消失。
//  honor system：app 不验证证书，由用户自报（与 PRD F4.2「POC 是 PALS 前置、用户自报」一致）。
//
//  POC 是 owner 级一次性资质（不分猫狗、不 per-pet）：AVS 要求每位首次领猫或狗牌照的主人
//  一生完成一次。本页读写 store.owner.pocCompleted，与具体宠物无关（故 init 无参）。
//

import SwiftUI

struct POCCourseView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.openURL) private var openURL

    /// 新加坡 AVS 免费在线 Pet Ownership Course（2024-09 起首次猫/狗领证前置，约 20–30 分钟）。
    /// gov.sg 官方短链，系统浏览器打开（课程页走 Singpass，系统 Safari 体验最佳）。
    private let courseURL = URL(string: "https://go.gov.sg/petownershipcourse")!

    /// 无参入口：POC 是 owner 级资质，与具体宠物无关（显式 internal init，保证跨文件可构造）。
    init() {}

    /// 是否已完成（owner 级：标记完成后 store.owner.pocCompleted 即时反映，底部按钮态随 @Observable 刷新）。
    private var isCompleted: Bool { store.owner.pocCompleted }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PPSpacing.xl) {
                hero
                aboutSection
                stepsSection
                honorNote
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.sm)
            .padding(.bottom, PPSpacing.xxxl)
        }
        .scrollIndicators(.hidden)
        .background(Color.ppBackground)
        .navigationTitle("Pet Ownership Course")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { bottomBar }
    }

    // MARK: - Hero（图标 + 宠物 + 标题）

    private var hero: some View {
        VStack(spacing: PPSpacing.md) {
            ZStack {
                Circle()
                    .fill(Color.ppPrimary.opacity(0.12))
                    .frame(width: 96, height: 96)
                Image(systemName: "graduationcap.fill")
                    .font(.largeTitle)
                    .foregroundStyle(Color.ppPrimary)
            }

            VStack(spacing: PPSpacing.xs) {
                Text("Pet Ownership Course")
                    .font(.title2)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                    .multilineTextAlignment(.center)

                Text(isCompleted
                     ? "Pet Ownership Course completed. This is a one-time requirement — you're all set for every cat or dog you licence."
                     : "A one-time online course AVS requires from every first-time cat or dog owner. Finish it once and you're set for every pet you licence.")
                    .font(.subheadline)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                // 迁移关键认知：同一门课覆盖猫狗（owner 级一次性），两态均成立。
                Text("Free · Online · The same course covers both cats and dogs")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.ppPrimary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, PPSpacing.sm)
    }

    // MARK: - About（课程是什么）

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            Text("ABOUT THE COURSE")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            VStack(spacing: PPSpacing.md) {
                factRow(icon: "gift.fill", title: "Free", subtitle: "No fee — provided by AVS.")
                factRow(icon: "clock.fill", title: "About 20–30 minutes", subtitle: "Complete it in one sitting, online.")
                factRow(icon: "person.badge.key.fill", title: "Sign in with Singpass", subtitle: "Your completion is recorded against your Singpass.")
                factRow(icon: "checkmark.seal.fill", title: "Required since Sep 2024", subtitle: "A prerequisite before first-time cat or dog licensing.")
            }
            .padding(PPSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .ppCard()
        }
    }

    private func factRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(Color.ppPrimary)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.ppPrimary.opacity(0.1)))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - Steps（两步引导）

    private var stepsSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            Text("HOW IT WORKS")
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.8)
                .foregroundStyle(Color.ppTextSecondary)

            VStack(alignment: .leading, spacing: PPSpacing.md) {
                stepRow(number: 1, text: "Tap “Start course” to open the official course in your browser, then complete it with Singpass.")
                stepRow(number: 2, text: "Come back here and tap “Mark as completed” so we can move your licensing steps forward.")
            }
        }
    }

    private func stepRow(number: Int, text: String) -> some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Text("\(number)")
                .font(.subheadline)
                .fontWeight(.bold)
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.ppPrimary))

            Text(text)
                .font(.subheadline)
                .foregroundStyle(Color.ppTextPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
    }

    // MARK: - Honor note

    private var honorNote: some View {
        Text("PetBook doesn't verify your certificate — just mark it done once you've completed the course.")
            .font(.caption)
            .foregroundStyle(Color.ppTextSecondary)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - 底部常驻行动区

    @ViewBuilder
    private var bottomBar: some View {
        VStack(spacing: PPSpacing.sm) {
            // ① 跳系统 Safari 看课程
            PPPrimaryButton(title: "Start course", systemImage: "arrow.up.right") {
                openURL(courseURL)
            }

            // ② 标记完成（已完成态置灰禁用，避免重复点）
            if isCompleted {
                HStack(spacing: PPSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                    Text("Completed")
                        .fontWeight(.semibold)
                }
                .font(.subheadline)
                .foregroundStyle(Color.ppPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, PPSpacing.md)
            } else {
                PPSecondaryButton(title: "Mark as completed") {
                    markCompleted()
                }
            }
        }
        .padding(.horizontal, PPSpacing.xl)
        .padding(.top, PPSpacing.md)
        .padding(.bottom, PPSpacing.lg)
    }

    // MARK: - 标记完成

    /// 把 owner.pocCompleted 置 true（走 updateOwner 通道：mock 改本地 / network PATCH /v1/owner）。
    /// owner 级一次性——完成后此人名下所有宠物的 completePOC 待办重算消失，返回首页即见卡片已不在。
    private func markCompleted() {
        Task { await store.updateOwner { $0.pocCompleted = true } }
        SWAlertManager.shared.show(.success, message: "Course marked as completed")
    }
}

#Preview("Not completed") {
    NavigationStack {
        POCCourseView()   // owner 未完成 POC（mock 默认）
    }
    .environment(PetBookStore())
}

#Preview("Completed") {
    let store = PetBookStore()
    store.owner.pocCompleted = true
    return NavigationStack {
        POCCourseView()   // owner 已完成 POC
    }
    .environment(store)
}
