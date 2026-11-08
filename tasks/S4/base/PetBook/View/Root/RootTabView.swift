//
//  RootTabView.swift
//  PetBook
//
//  4 个一级 tab（Home / Map / Orders / Profile）+ 自定义 tab bar 浮层。
//  每个 tab 是独立 NavigationStack，路由互不影响。
//  Tab bar 通过 PetBookTabBarController 控制显隐：一级页面 onAppear retain，
//  二级 push 页面（未调用 .ppShowsRootTabBar()）会自动让 bar 下滑+淡出。
//  selectedTab 提升到 PetBookTabBarController（全局），支持跨页面编程式切 tab。
//

import SwiftUI

struct RootTabView: View {
    @Environment(PetBookTabBarController.self) private var tabBar

    var body: some View {
        @Bindable var tabBar = tabBar

        ZStack(alignment: .bottom) {
            Group {
                switch tabBar.selectedTab {
                case .home:
                    NavigationStack { HomeView() }
                case .map:
                    NavigationStack { MapView() }
                case .orders:
                    NavigationStack { AppointmentsView() }
                case .profile:
                    NavigationStack { ProfileView() }
                }
            }
            .tint(Color.ppPrimary)

            CustomTabBar(selectedTab: $tabBar.selectedTab)
                .padding(.bottom, PPSpacing.md)
                .offset(y: tabBar.isVisible ? -10 : 160)
                .opacity(tabBar.isVisible ? 1 : 0)
                .animation(.easeInOut(duration: 0.3), value: tabBar.isVisible)
        }
        .ignoresSafeArea(edges: .bottom)
    }
}

#Preview {
    RootTabView()
        .environment(PetBookStore())
        .environment(PetBookTabBarController())
}
