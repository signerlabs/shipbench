//
//  HomeNextStepCard.swift
//  PetBook
//
//  首页「待办动作」卡片：一张卡 = 一只宠物当前最该做的一步（HomeFeed.nextSteps 产出）。
//  从 HomeView 抽离独立成文件。HomeView 用 section 标题 + ForEach 把所有待办从上到下铺开，
//  故卡内不再重复 "YOUR NEXT STEP" 标签，只留动作图标 + 宠物头像辨识。
//  点击分流：合规类 → push（回调给 HomeView）；健康类 → toast 占位。
//

import SwiftUI

struct HomeNextStepCard: View {
    let step: HomeNextStep
    /// Hero 形态：首屏「当前最该做的一件事」用主色渐变满底 + 白字（HomeView 保证同屏只有一张 hero）；
    /// 其余卡走 Standard 纸面卡（.ppCard）。
    var isHero: Bool = false
    /// 合规类动作 → 回调给 HomeView 设置 push 目标；非合规类（健康）仍在卡内 toast 占位。
    let onCompliance: (ComplianceDestination) -> Void

    // 健康类点击 → 弹对应录入 sheet（addFirstVaccine / bookHealth 来源疫苗 → 疫苗；bookHealth 来源驱虫 → 驱虫）
    @State private var showVaccineSheet = false
    @State private var showDewormingSheet = false

    var body: some View {
        Button { trigger() } label: {
            VStack(alignment: .leading, spacing: PPSpacing.md) {
                HStack(spacing: PPSpacing.sm) {
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(isHero ? Color.ppPrimary : .white)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(isHero ? Color.white : Color.ppPrimary))
                    Spacer()
                }

                VStack(alignment: .leading, spacing: PPSpacing.xs) {
                    Text(title)
                        .font(.title3)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(isHero ? .white : Color.ppTextPrimary)
                        .multilineTextAlignment(.leading)
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(isHero ? .white.opacity(0.88) : Color.ppTextSecondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: PPSpacing.xs) {
                    Text(cta)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(isHero ? Color.ppPrimary : .white)
                .padding(.horizontal, PPSpacing.lg)
                .padding(.vertical, PPSpacing.sm)
                .background(Capsule().fill(isHero ? AnyShapeStyle(Color.white) : AnyShapeStyle(Color.ppPrimary.gradient)))
            }
            .padding(PPSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)

            .background(alignment: .topTrailing) {
                PPPetAvatar(pet: step.pet, size: 48)
                    .padding()
            }
            .background(
                RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                    .fill(isHero ? AnyShapeStyle(Color.ppPrimary.gradient) : AnyShapeStyle(Color.ppSurface))
                    .shadow(color: isHero ? Color.ppPrimary.opacity(0.30) : .black.opacity(0.06),
                            radius: isHero ? 16 : 12, x: 0, y: isHero ? 8 : 4)
            )
        }
        .buttonStyle(.ppPress)
        .sheet(isPresented: $showVaccineSheet) {
            AddVaccinationSheet(petID: step.pet.id)
        }
        .sheet(isPresented: $showDewormingSheet) {
            AddDewormingSheet(petID: step.pet.id)
        }
    }

    // MARK: 展示映射（kind → 图标 / 文案 / CTA / 骨架点击）

    private var name: String { step.pet.name }

    private var icon: String {
        switch step.kind {
        case .renewLicence:       "doc.text.fill"
        case .completePOC:        "graduationcap.fill"
        case .applyCatLicence:    "checkmark.seal.fill"
        case .registerDogLicence: "doc.badge.plus"
        case .checkHDBOptions:    "building.2.fill"
        case .bookHealth:         "stethoscope"
        case .addFirstVaccine:    "syringe"
        }
    }

    private var title: String {
        switch step.kind {
        case .renewLicence:
            step.pet.species == .dog ? "Renew \(name)'s dog licence" : "Renew \(name)'s cat licence"
        case .completePOC:        "Complete the Pet Ownership Course"
        case .applyCatLicence:    "Apply for \(name)'s cat licence"
        case .registerDogLicence: "Register \(name)'s dog licence"
        case .checkHDBOptions:    "Check HDB options for \(name)"
        case .bookHealth:         "\(step.detailNoun ?? "Appointment") for \(name)"
        case .addFirstVaccine:    "Add \(name)'s first vaccine"
        }
    }

    private var detail: String {
        switch step.kind {
        case .renewLicence:
            if let d = step.daysRemaining {
                return d < 0 ? "Expired \(abs(d)) days ago — renew on PALS to stay compliant"
                             : "Expires in \(d) days — renew on PALS before it lapses"
            }
            return "Renew on PALS to stay compliant"
        case .completePOC:
            return "One-time step for licensing any cat or dog"
        case .applyCatLicence:
            // 过渡期内（≤ 2026-08-31）强调免费登记倒计时；过了截止日回退常规合规催促。
            if let d = step.daysRemaining, d >= 0 {
                return "Free registration ends in \(d) days (by 31 Aug 2026) — licence \(name) on PALS now"
            }
            return "Cat licensing is mandatory in Singapore — licence \(name) on PALS to stay compliant"
        case .registerDogLicence:
            return "Every dog in Singapore needs an AVS licence — register on PALS"
        case .checkHDBOptions:
            return "\(name)'s breed isn't HDB-approved — see your compliant options"
        case .bookHealth:
            let d = step.daysRemaining ?? 0
            return d <= 0 ? "Due now — log \(name)'s record once done"
                          : "Due in \(d) days — log \(name)'s record once done"
        case .addFirstVaccine:
            return "Keep \(name)'s health records in one place"
        }
    }

    private var cta: String {
        switch step.kind {
        case .renewLicence:       "Renew on PALS"
        case .completePOC:        "Start course"
        case .applyCatLicence:    "Apply on PALS"
        case .registerDogLicence: "Register on PALS"
        case .checkHDBOptions:    "See options"
        case .bookHealth:         "Add record"
        case .addFirstVaccine:    "Add record"
        }
    }

    /// 点击分流：完成 POC → push POC 课程详情页（看课程 + 标记完成的闭环）；牌照相关 → push PALS 助手；
    /// HDB → 检查器；健康 2 个 case（bookHealth / addFirstVaccine）保留 toast / sheet。
    private func trigger() {
        switch step.kind {
        // 完成 Pet Ownership Course → push POC 详情页（owner 级：页内跳课程 + 看完回来标记完成 → 待办消失）
        case .completePOC:
            onCompliance(.poc)
        // 牌照相关（续期 / 申猫牌 / 登记狗牌）→ PALS 助手
        case .renewLicence, .applyCatLicence, .registerDogLicence:
            onCompliance(.pals(pet: step.pet))
        // 住 HDB 养非准养犬 → HDB 合规检查器
        case .checkHDBOptions:
            onCompliance(.hdbChecker(pet: step.pet))
        // 健康类（非合规模块）：点击弹对应录入 sheet（阶段一只来自疫苗 / 驱虫，复诊归阶段二、不会出现）
        case .bookHealth:
            if step.sourceKind == .deworming {
                showDewormingSheet = true
            } else {
                showVaccineSheet = true
            }
        case .addFirstVaccine:
            // 添加首条疫苗 → 弹录入 sheet（保存后 store 加疫苗，addFirstVaccine 待办自动消失）
            showVaccineSheet = true
        }
    }
}

// MARK: - Previews

#Preview("Cat") {
    let cat = Pet.mocks[0] // Mochi
    ScrollView {
        VStack(spacing: PPSpacing.md) {
            HomeNextStepCard(step: .init(kind: .renewLicence, pet: cat, daysRemaining: 12), isHero: true) { _ in }
            HomeNextStepCard(step: .init(kind: .renewLicence, pet: cat, daysRemaining: 12)) { _ in }
            HomeNextStepCard(step: .init(kind: .renewLicence, pet: cat, daysRemaining: -5)) { _ in }
            HomeNextStepCard(step: .init(kind: .completePOC, pet: cat)) { _ in }
            HomeNextStepCard(step: .init(kind: .applyCatLicence, pet: cat,
                                         daysRemaining: HomeFeed.daysUntil(HomeFeed.catLicensingDeadline))) { _ in }
            HomeNextStepCard(step: .init(kind: .bookHealth, pet: cat,
                                         daysRemaining: 3, detailNoun: "Rabies vaccine", sourceKind: .vaccine)) { _ in }
            HomeNextStepCard(step: .init(kind: .bookHealth, pet: cat,
                                         daysRemaining: 0, detailNoun: "Heartworm prevention", sourceKind: .deworming)) { _ in }
            HomeNextStepCard(step: .init(kind: .addFirstVaccine, pet: cat)) { _ in }
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
    .environment(PetBookStore())
}

#Preview("Dog") {
    let dog = Pet.mocks[1] // Buddy
    ScrollView {
        VStack(spacing: PPSpacing.md) {
            HomeNextStepCard(step: .init(kind: .renewLicence, pet: dog, daysRemaining: 12)) { _ in }
            HomeNextStepCard(step: .init(kind: .renewLicence, pet: dog, daysRemaining: -5)) { _ in }
            HomeNextStepCard(step: .init(kind: .registerDogLicence, pet: dog)) { _ in }
            HomeNextStepCard(step: .init(kind: .checkHDBOptions, pet: dog)) { _ in }
            HomeNextStepCard(step: .init(kind: .bookHealth, pet: dog,
                                         daysRemaining: 3, detailNoun: "Rabies vaccine", sourceKind: .vaccine)) { _ in }
            HomeNextStepCard(step: .init(kind: .bookHealth, pet: dog,
                                         daysRemaining: 0, detailNoun: "Heartworm prevention", sourceKind: .deworming)) { _ in }
            HomeNextStepCard(step: .init(kind: .addFirstVaccine, pet: dog)) { _ in }
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
    .environment(PetBookStore())
}
