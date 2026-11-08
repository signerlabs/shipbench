//
//  PetBookTabBarController.swift
//  PetBook
//
//  全局浮层 tab bar 控制器：管理可见性 + 当前选中的一级 tab。
//  默认隐藏，一级 tab 根页面（Home / Map / Orders / Profile）通过 `.ppShowsRootTabBar()`
//  retain 显示；二级 push 页面（NotificationsView、宠物详情等）不调用即自动隐藏。
//
//  使用计数器而非 Bool — 切换 tab 时旧根的 onDisappear（release）和新根的 onAppear
//  （retain）会交错执行，若用 Bool 会瞬间归 false 引发 tab bar 闪烁。计数器吸收交错。
//
//  selectedTab 提升到此全局控制器（原在 RootTabView 私有 @State），便于跨页面切 tab：
//  如 Home 时间线里点预约条目 → `tabBar.selectedTab = .orders` 切到 Orders。
//

import SwiftUI
import MapKit

@Observable
@MainActor
final class PetBookTabBarController {
    /// 当前选中的一级 tab（提升到全局，供跨页面编程式切换）。
    var selectedTab: PPTab = .home

    /// Map tab 的相机位置（提升到全局）：切走 Map 再回来不重置，「镜头到哪算哪」。
    /// MapView 是条件渲染（切 tab 即销毁重建），@State 会丢，故状态托管在此全局控制器。
    var mapCameraPosition: MapCameraPosition = .region(MapView.islandRegion)
    /// Map 是否已在 app 生命周期内首次自动聚焦到用户位置（只首次定位一次，之后保留用户视角）。
    var mapDidInitialZoom = false

    /// >0 = 显示。
    private var showCount: Int = 0

    var isVisible: Bool { showCount > 0 }

    func retain() { showCount += 1 }
    func release() { showCount = max(0, showCount - 1) }
}

// MARK: - Modifier

extension View {
    /// 标记为一级 tab 根页面：appear 时 retain tab bar，disappear 时 release。
    /// 二级 push 页面不应调用此 modifier — 不调用即自动隐藏 tab bar。
    func ppShowsRootTabBar() -> some View {
        modifier(PPShowsRootTabBarModifier())
    }
}

private struct PPShowsRootTabBarModifier: ViewModifier {
    @Environment(PetBookTabBarController.self) private var tabBar

    func body(content: Content) -> some View {
        content
            .onAppear { tabBar.retain() }
            .onDisappear { tabBar.release() }
    }
}
