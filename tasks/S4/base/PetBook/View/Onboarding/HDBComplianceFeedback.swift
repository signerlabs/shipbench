//
//  HDBComplianceFeedback.swift
//  PetBook
//
//  HDBComplianceStatus 的展示层映射（颜色 / 图标 / 文案）+ 两个展示组件：
//    • HDBComplianceBadge        — picker 行尾小徽章，传达该品种所属分类
//    • HDBComplianceFeedbackBanner — 选中狗品种后表单内的实时合规反馈横幅
//
//  文案要点对齐 PRD §10「合规文案要点（仅狗）」。
//  模型层 HDBComplianceStatus 保持纯数据（Foundation），颜色/文案等展示信息集中在此。
//

import SwiftUI

extension HDBComplianceStatus {
    /// 语义强调色。绿/橙已收敛到主题 colorset（ppSuccess / ppWarning）；
    /// 无对应 colorset 的（紫/蓝）走 SwiftUI 系统色，禁用 Color(hex:)。
    var accent: Color {
        switch self {
        case .hdbApproved:         Color.ppSuccess
        case .notHDBApproved:      .purple
        case .specifiedRestricted: Color.ppWarning
        case .prohibited:          Color.ppDanger
        case .adoreEligible:       .blue
        case .unknownMixed:        Color.ppTextSecondary
        }
    }

    var iconName: String {
        switch self {
        case .hdbApproved:         "checkmark.seal.fill"
        case .notHDBApproved:      "building.2.fill"
        case .specifiedRestricted: "exclamationmark.triangle.fill"
        case .prohibited:          "xmark.octagon.fill"
        case .adoreEligible:       "pawprint.circle.fill"
        case .unknownMixed:        "questionmark.circle.fill"
        }
    }

    /// picker 行尾徽章短标签
    var badgeLabel: LocalizedStringKey {
        switch self {
        case .hdbApproved:         "HDB OK"
        case .notHDBApproved:      "Non-HDB"
        case .specifiedRestricted: "Restricted"
        case .prohibited:          "Banned"
        case .adoreEligible:       "ADORE"
        case .unknownMixed:        "Check"
        }
    }

    var feedbackTitle: LocalizedStringKey {
        switch self {
        case .hdbApproved:         "HDB-approved breed"
        case .notHDBApproved:      "Welcome in condos & landed homes"
        case .specifiedRestricted: "Specified (restricted) dog"
        case .prohibited:          "Banned in Singapore"
        case .adoreEligible:       "Eligible via Project ADORE"
        case .unknownMixed:        "We can't verify this breed"
        }
    }

    var feedbackMessage: LocalizedStringKey {
        switch self {
        case .hdbApproved:
            "This breed is on HDB's approved list — it can be kept in an HDB flat."
        case .notHDBApproved:
            "This breed is loved in Singapore — welcome in condos and landed homes, just not in HDB flats. Set on an HDB? Ask us about Project ADORE's K-9 scheme."
        case .specifiedRestricted:
            "Allowed in Singapore, but requires insurance, muzzling & leashing — and is not permitted in HDB flats."
        case .prohibited:
            "This breed cannot be kept in Singapore."
        case .adoreEligible:
            "Local mixed breeds can be kept in HDB flats via Project ADORE (adopt from an AWG partner, shoulder height ≤55cm, one per household)."
        case .unknownMixed:
            "We couldn't match this to a known breed. Check HDB & AVS rules for your dog before applying."
        }
    }
}

// MARK: - 行尾徽章

struct HDBComplianceBadge: View {
    let status: HDBComplianceStatus

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: status.iconName)
            Text(status.badgeLabel)
        }
        .font(.caption2)
        .fontWeight(.semibold)
        .foregroundStyle(status.accent)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(status.accent.opacity(0.12)))
    }
}

// MARK: - 实时反馈横幅

struct HDBComplianceFeedbackBanner: View {
    let status: HDBComplianceStatus

    var body: some View {
        HStack(alignment: .top, spacing: PPSpacing.md) {
            Image(systemName: status.iconName)
                .font(.title3)
                .foregroundStyle(status.accent)

            VStack(alignment: .leading, spacing: 2) {
                Text(status.feedbackTitle)
                    .font(.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextPrimary)
                Text(status.feedbackMessage)
                    .font(.caption)
                    .foregroundStyle(Color.ppTextSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(PPSpacing.md)
        .background(
            // tinted 卡靠色块分层，无描边（设计语言 v2）
            RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                .fill(status.accent.opacity(0.1))
        )
    }
}

#Preview("Banners") {
    VStack(spacing: 16) {
        ForEach(HDBComplianceStatus.allCases, id: \.self) { status in
            HDBComplianceFeedbackBanner(status: status)
        }
    }
    .padding(24)
    .background(Color.ppBackground)
}
