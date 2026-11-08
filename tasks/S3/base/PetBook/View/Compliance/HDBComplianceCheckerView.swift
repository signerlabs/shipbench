//
//  HDBComplianceCheckerView.swift
//  PetBook
//
//  F4.1 HDB 合规检查器（二级 push 页，不挂 .ppShowsRootTabBar() → tab bar 自动隐藏）。
//  HDB 合规只对狗有意义（猫品种无 status），故本检查器聚焦狗。
//  输入：品种（可切换/自由查）× 住宅类型（缺省时页内补填并写回 store.owner）。
//  输出：「住宅类型 × 品种 status → 最终 verdict + 文案」结论卡。
//
//  ⚠️ 核心产品逻辑「住宅 × status → verdict」集中在本文件的 HDBVerdict / ComplianceOutcome，
//     按 PRD 拍板的映射表实现，不自由发挥（见 ComplianceOutcome.resolve）。
//

import SwiftUI

// MARK: - Verdict（三档结论）

/// 最终结论档位。绿=允许 / 橙=有条件 / 红=不可。
enum HDBVerdict {
    case allowed       // ✅ 允许
    case conditional   // ⚠️ 有条件 / 需进一步动作
    case notAllowed    // ❌ 不可

    var accent: Color {
        switch self {
        case .allowed:     Color.ppSuccess
        case .conditional: Color.ppWarning
        case .notAllowed:  Color.ppDanger
        }
    }

    var iconName: String {
        switch self {
        case .allowed:     "checkmark.seal.fill"
        case .conditional: "exclamationmark.triangle.fill"
        case .notAllowed:  "xmark.octagon.fill"
        }
    }
}

// MARK: - 结论模型（住宅 × status → verdict + 文案）

/// 「住宅类型 × 品种 status」算出的最终结论。
/// 这是本模块最重要的产品逻辑：按 PRD 拍板映射表实现，title/message 按住宅类型调整口径。
struct ComplianceOutcome {
    let verdict: HDBVerdict
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    /// 行动指引（仅 ADORE 类有值）：引导了解 Project ADORE。
    var actionHint: LocalizedStringKey? = nil

    /// 核心映射：住宅类型 × 品种 status → 结论。映射表见文件头 / PRD。
    static func resolve(status: HDBComplianceStatus, residence: ResidenceType) -> ComplianceOutcome {
        let isHDB = residence == .hdb

        switch status {
        // ── HDB 白名单：两种住宅都允许 ──
        case .hdbApproved:
            return .init(
                verdict: .allowed,
                title: "Approved for your home",
                message: isHDB
                    ? "This breed is on HDB's approved list — it can be kept in your HDB flat."
                    : "This HDB-approved breed can be kept in your \(residence.displayName.lowercased()) home. You're good to go."
            )

        // ── 合法非白名单：HDB 不可（可走 ADORE 了解）/ condo·landed 欢迎 ──
        case .notHDBApproved:
            if isHDB {
                return .init(
                    verdict: .conditional,
                    title: "Not allowed in HDB flats",
                    message: "This breed isn't on HDB's approved list, so it can't be kept in an HDB flat. Local mixed breeds may qualify through Project ADORE.",
                    actionHint: "Learn about Project ADORE's K-9 scheme"
                )
            } else {
                return .init(
                    verdict: .allowed,
                    title: "Welcome in your \(residence.displayName.lowercased()) home",
                    message: "This breed is loved in Singapore and can be kept in condos and landed homes — your \(residence.displayName.lowercased()) home is a great fit."
                )
            }

        // ── ADORE 适格（Singapore Special / 本地混种）──
        case .adoreEligible:
            if isHDB {
                return .init(
                    verdict: .conditional,
                    title: "Eligible via Project ADORE",
                    message: "Local mixed breeds can be kept in HDB flats through Project ADORE — adopt from an AWG partner, shoulder height ≤55cm, one per household.",
                    actionHint: "Learn about Project ADORE"
                )
            } else {
                return .init(
                    verdict: .allowed,
                    title: "Welcome in your \(residence.displayName.lowercased()) home",
                    message: "Singapore Specials make wonderful companions and can be kept in your \(residence.displayName.lowercased()) home."
                )
            }

        // ── Specified Dog Part 2：HDB 一律不可 / condo·landed 需保险+口套+牵引 ──
        case .specifiedRestricted:
            if isHDB {
                return .init(
                    verdict: .notAllowed,
                    title: "Not permitted in HDB flats",
                    message: "This is a Specified (restricted) dog. It cannot be kept in HDB flats under any circumstances."
                )
            } else {
                return .init(
                    verdict: .conditional,
                    title: "Allowed with extra requirements",
                    message: "This Specified (restricted) dog can be kept in your \(residence.displayName.lowercased()) home, but requires insurance, muzzling and leashing in public."
                )
            }

        // ── Specified Dog Part 1：新加坡禁养（两种住宅都不可）──
        case .prohibited:
            return .init(
                verdict: .notAllowed,
                title: "Banned in Singapore",
                message: "This breed is prohibited in Singapore and cannot be kept in any home."
            )

        // ── 无法核实：两种住宅都提示自查 ──
        case .unknownMixed:
            return .init(
                verdict: .conditional,
                title: "We can't verify this breed",
                message: isHDB
                    ? "We couldn't match this to a known breed. Check HDB & AVS rules for your dog before applying."
                    : "We couldn't match this to a known breed. Check AVS rules for your dog before applying."
            )
        }
    }
}

// MARK: - 检查器主体

struct HDBComplianceCheckerView: View {
    @Environment(PetBookStore.self) private var store

    /// 当前选中的狗品种名（页内可切换 / 自由查）。
    @State private var selectedBreed: String

    /// 来源宠物（若由某只狗进入）。仅用于头部展示，逻辑只认 selectedBreed。
    private let sourcePet: Pet?

    /// 由某只狗进入（带入它的品种）。
    init(pet: Pet) {
        self.sourcePet = pet
        _selectedBreed = State(initialValue: pet.breed ?? "")
    }

    /// 自由查某品种（"我想养某品种"）。
    init(breed: String = "") {
        self.sourcePet = nil
        _selectedBreed = State(initialValue: breed)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PPSpacing.xl) {
                if let sourcePet {
                    petHeader(sourcePet)
                }
                breedSection
                residenceSection
                outcomeSection
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.sm)
            .padding(.bottom, PPSpacing.xxxl)
        }
        .background(Color.ppBackground)
        .navigationTitle("HDB Check")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - 当前品种 status（未命中目录则 unknownMixed）

    private var currentStatus: HDBComplianceStatus {
        BreedCatalog.dogStatus(for: selectedBreed) ?? .unknownMixed
    }

    // MARK: - 来源宠物头部

    private func petHeader(_ pet: Pet) -> some View {
        HStack(spacing: PPSpacing.md) {
            PPPetAvatar(pet: pet, size: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(pet.name)
                    .font(.title3)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                Text("Checking HDB eligibility")
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
            }
            Spacer(minLength: 0)
        }
    }

    // MARK: - 品种选择（复用 PPSearchablePicker + 行尾 HDB 徽章）

    private var breedSection: some View {
        PPLabeledField(label: "Breed", hint: "Search any breed to check HDB eligibility") {
            PPSearchablePicker(
                placeholder: "Select breed",
                sheetTitle: "Select Dog Breed",
                searchPrompt: "Search breeds",
                selection: $selectedBreed,
                options: BreedCatalog.dogBreedNames
            ) { name in
                if let status = BreedCatalog.dogStatus(for: name) {
                    HDBComplianceBadge(status: status)
                }
            }
        }
    }

    // MARK: - 住宅类型（store 缺省时页内补填并写回）

    private var residenceSection: some View {
        // 选中即写回 owner.residenceType，并走 updateOwner 落库（乐观更新 + PATCH + 失败回滚）。
        // 直接改 store.owner.residenceType 只动内存副本，会被 bootstrap 拉后端 owner 覆盖而丢失，
        // 与 UI「we'll remember it」的承诺矛盾；必须经 updateOwner 持久化。对齐 ProfileView 的 HomeTypeSheet。
        // 对齐 PRD §7.3：首次用检查器补填住宅类型。
        PPLabeledField(
            label: "Your home type",
            hint: store.owner.residenceType == nil
                ? "Pick your home type — we'll remember it"
                : "Different home? Tap to change",
            bordered: false
        ) {
            HStack(spacing: PPSpacing.sm) {
                ForEach(ResidenceType.allCases) { type in
                    PPSegmentChip(
                        title: type.displayName,
                        isSelected: store.owner.residenceType == type
                    ) {
                        Task { await store.updateOwner { $0.residenceType = type } }
                    }
                }
            }
        }
    }

    // MARK: - 结论区（住宅 × status → verdict 卡）

    @ViewBuilder
    private var outcomeSection: some View {
        if selectedBreed.isEmpty {
            // 尚未选品种：提示先选
            placeholderHint("Select a breed above to see whether it can be kept in your home.")
        } else if let residence = store.owner.residenceType {
            let outcome = ComplianceOutcome.resolve(status: currentStatus, residence: residence)
            ComplianceOutcomeCard(outcome: outcome)
        } else {
            // 有品种但未选住宅：提示先补填
            placeholderHint("Pick your home type above to get a tailored result.")
        }
    }

    private func placeholderHint(_ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(systemName: "info.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.ppTextSecondary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(Color.ppTextSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(PPSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ppCard(cornerRadius: PPRadius.md)
    }
}

// MARK: - 结论卡（吃 ComplianceOutcome，视觉沿用 HDBComplianceFeedbackBanner 风格）

struct ComplianceOutcomeCard: View {
    let outcome: ComplianceOutcome

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            HStack(alignment: .top, spacing: PPSpacing.md) {
                Image(systemName: outcome.verdict.iconName)
                    .font(.title2)
                    .foregroundStyle(outcome.verdict.accent)

                VStack(alignment: .leading, spacing: PPSpacing.xs) {
                    Text(outcome.title)
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(outcome.message)
                        .font(.subheadline)
                        .foregroundStyle(Color.ppTextSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)
            }

            // ADORE 等需要行动指引时，给一行带箭头的引导（骨架阶段先 toast 占位）
            if let actionHint = outcome.actionHint {
                Button {
                    SWAlertManager.shared.show(.info, message: "Project ADORE info coming soon")
                } label: {
                    HStack(spacing: PPSpacing.xs) {
                        Text(actionHint)
                            .font(.subheadline)
                            .fontWeight(.semibold)
                        Image(systemName: "arrow.right")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(outcome.verdict.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(PPSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            // tinted 卡靠色块分层，无描边（设计语言 v2，与通知权限 banner 口径一致）
            RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                .fill(outcome.verdict.accent.opacity(0.1))
        )
    }
}

#Preview("Checker — HDB + Labrador") {
    NavigationStack {
        HDBComplianceCheckerView(breed: "Labrador Retriever")
    }
    .environment(PetBookStore())
}

#Preview("All outcomes") {
    ScrollView {
        VStack(spacing: PPSpacing.lg) {
            ForEach(HDBComplianceStatus.allCases, id: \.self) { status in
                ForEach(ResidenceType.allCases) { residence in
                    ComplianceOutcomeCard(
                        outcome: .resolve(status: status, residence: residence)
                    )
                }
            }
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
}
