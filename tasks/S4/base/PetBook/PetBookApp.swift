//
//  PetBookApp.swift
//  PetBook
//

import SwiftUI

@main
struct PetBookApp: App {
    // 数据源开关：
    //   .network = pet 接真实 Supabase 后端（M1 端到端）
    //   .mock    = 纯本地 mock，零网络（调试 UI 时切到这里即可）
    // ⚠️ 只影响真机/模拟器运行；所有 #Preview 仍走无参 PetBookStore() = mock，不受此影响。
    @State private var store = PetBookStore(dataSource: .network)
    @State private var tabBar = PetBookTabBarController()
    @State private var locationManager = LocationManager()

    var body: some Scene {
        WindowGroup {
            // 不再铺统一根背景（SwiftUI 根背景不向子层透传，靠它兜底易漏）。
            // 改为「每个会单独显示的顶层视图各自保证 .background(Color.ppBackground)」，职责清晰。
            RootView()
                .environment(store)
                .environment(tabBar)
                .environment(locationManager)
                .preferredColorScheme(.light)
                .swAlert()
                // 启动引导：网络模式下匿名登录 / 复用 token + 拉取 pets；mock 模式内部直接返回。
                .task {
                    ReviewManager.shared.recordLaunch()
                    await store.bootstrap()
                }
                // 诊所名录拉远端覆盖 bundle 兜底：公开数据、不依赖登录态，与 bootstrap 并行独立跑。
                .task {
                    await store.loadClinics()
                }
        }
    }
}
