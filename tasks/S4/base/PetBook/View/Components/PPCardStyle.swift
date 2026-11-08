//
//  PPCardStyle.swift
//  PetBook
//
//  设计语言 v2 的三个全局基元（P1）：
//    • .ppCard()      — Standard 卡片：ppSurface 底 + continuous 圆角 + 极软阴影。
//                       取代「白底 + 1px ppBorder 描边」的线框卡，整体气质从线框感转纸面感。
//    • PPPressStyle   — 可点卡片统一按压反馈：scale 0.98 + spring 回弹（.buttonStyle(.ppPress)）。
//    • PPUrgency      — 紧急度视觉三档（overdue / soon / normal），Home 时间线与通知中心共用，
//                       决定图标容器配色与到期文字强调色。
//

import SwiftUI

// MARK: - Standard 卡片

extension View {
    /// Standard 卡：ppSurface 填充 + 软阴影（阴影只挂在卡片形状上，不影响内容）。
    func ppCard(cornerRadius: CGFloat = PPRadius.lg) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.ppSurface)
                .shadow(color: .black.opacity(0.06), radius: 12, x: 0, y: 4)
        )
    }
}

// MARK: - 按压反馈

/// 可点卡片统一按压态：轻微缩放 + spring 回弹（配合各卡已有的 sensoryFeedback）。
struct PPPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PPPressStyle {
    static var ppPress: PPPressStyle { PPPressStyle() }
}

// MARK: - 紧急度三档

/// 到期事项的紧急度视觉映射：过期 = 红实底、≤7 天 = 主色淡底、其余 = 中性。
/// 生日等「非催办」事项传 muted: true 恒走中性档。
enum PPUrgency {
    case overdue
    case soon
    case normal

    init(daysUntil d: Int, muted: Bool = false) {
        if muted { self = .normal }
        else if d < 0 { self = .overdue }
        else if d <= 7 { self = .soon }
        else { self = .normal }
    }

    /// 图标容器内 SF Symbol 颜色
    var iconForeground: Color {
        switch self {
        case .overdue: .white
        case .soon:    Color.ppPrimary
        case .normal:  Color.ppTextSecondary
        }
    }

    /// 图标容器底色
    var iconBackground: Color {
        switch self {
        case .overdue: Color.ppDanger
        case .soon:    Color.ppPrimary.opacity(0.12)
        case .normal:  Color.ppBackground
        }
    }

    /// 到期文字强调色（"overdue by 3d" / "due in 5 days"）
    var accent: Color {
        switch self {
        case .overdue: Color.ppDanger
        case .soon:    Color.ppPrimary
        case .normal:  Color.ppTextSecondary
        }
    }
}

#Preview("Card + Press + Urgency") {
    VStack(spacing: PPSpacing.xl) {
        Button {} label: {
            HStack(spacing: PPSpacing.md) {
                ForEach([PPUrgency.overdue, .soon, .normal], id: \.self) { u in
                    Image(systemName: "syringe")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(u.iconForeground)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(u.iconBackground))
                }
                Text("Standard card")
                    .font(.headline)
                    .foregroundStyle(Color.ppTextPrimary)
                Spacer()
            }
            .padding(PPSpacing.lg)
            .ppCard()
        }
        .buttonStyle(.ppPress)
    }
    .padding(PPSpacing.xl)
    .frame(maxHeight: .infinity)
    .background(Color.ppBackground)
}

extension PPUrgency: Hashable {}
