//
//  CustomTabBar.swift
//  PetBook
//
//  浮层胶囊形自定义 tab bar（参考别的项目的风格）：
//   - 每个 item 内部纵向 VStack：icon 上 / label 下
//   - HStack(spacing: -10) 让选中胶囊背景能稍稍叠在相邻 item 上
//   - ultraThinMaterial + 白色叠层（浅色调）+ 软阴影 + hairline 描边
//   - 选中态：填充 SF Symbol + 主色文本 + 主色 12% 透明度内嵌胶囊
//   - 通过 PetBookTabBarController 控制显隐（一级页面调 .ppShowsRootTabBar()）
//

import SwiftUI

enum PPTab: String, CaseIterable, Identifiable {
    case home, map, orders, profile
    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .map: "Map"
        case .orders: "Orders"
        case .profile: "Profile"
        }
    }

    var icon: String {
        switch self {
        case .home: "house"
        case .map: "map"
        case .orders: "calendar"
        case .profile: "person"
        }
    }

    var iconFilled: String {
        switch self {
        case .home: "house.fill"
        case .map: "map.fill"
        case .orders: "calendar"
        case .profile: "person.fill"
        }
    }

    /// 阶段一可见 tab（隐藏 Orders / 到店预约，归阶段二）。
    /// orders case 及全部定义保留；阶段二恢复时把 `.orders` 加回本数组即可（PRD §2 / §4.0）。
    static let phaseOneVisible: [PPTab] = [.home, .map, .profile]
}

struct CustomTabBar: View {
    @Binding var selectedTab: PPTab

    private let barHeight: CGFloat = 64
    private let itemWidth: CGFloat = 100

    var body: some View {
        HStack(spacing: -10) {
            ForEach(PPTab.phaseOneVisible) { tab in
                tabItem(tab)
            }
        }
        .background {
            ZStack {
                Capsule().fill(.ultraThinMaterial)
                Capsule().fill(Color.white.opacity(0.7))
            }
        }
        .overlay(
            Capsule().strokeBorder(Color.ppBorder.opacity(0.6), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.08), radius: 16, x: 0, y: 4)
        .sensoryFeedback(.selection, trigger: selectedTab)
    }

    @ViewBuilder
    private func tabItem(_ tab: PPTab) -> some View {
        let isSelected = selectedTab == tab

        Button {
            selectedTab = tab
        } label: {
            VStack(spacing: 3) {
                Image(systemName: isSelected ? tab.iconFilled : tab.icon)
                    .font(.title3)
                    .foregroundStyle(isSelected ? Color.ppPrimary : Color.ppTextSecondary)
                    .environment(\.symbolVariants, .none)

                Text(tab.title)
                    .font(.caption2.weight(isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.ppPrimary : Color.ppTextSecondary)
                    .lineLimit(1)
            }
            .frame(width: itemWidth, height: barHeight)
            .background(
                Capsule()
                    .fill(isSelected ? Color.ppPrimary.opacity(0.12) : Color.clear)
                    .padding(4)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.18), value: isSelected)
    }
}

#Preview {
    @Previewable @State var tab: PPTab = .home

    VStack {
        Spacer()
        CustomTabBar(selectedTab: $tab)
    }
    .background(Color.ppBackground)
}
