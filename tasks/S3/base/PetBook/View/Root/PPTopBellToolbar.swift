//
//  PPTopBellToolbar.swift
//  PetBook
//
//  一级页面共用的右上角 bell 工具栏按钮 modifier。
//  4 个一级页面（Home / Pets / Map / Profile）通过 .ppBellToolbar() 一次性挂上。
//

import SwiftUI

private struct PPBellToolbarModifier: ViewModifier {
    /// true = 沉浸式页面用（Home 顶部是照片背景）：bell 加 material 圆底保证任何图上都可见。
    var prominent: Bool = false

    @Environment(PetBookStore.self) private var store
    @State private var showNotifications = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNotifications = true
                    } label: {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: "bell")

                            if store.unreadNotificationCount > 0 {
                                Circle()
                                    .fill(Color.ppPrimary)
                                    .frame(width: 8, height: 8)
                                    .overlay(
                                        Circle().strokeBorder(Color.ppBackground, lineWidth: 1.5)
                                    )
                            }
                        }
                    }
                }
            }
            .navigationDestination(isPresented: $showNotifications) {
                NotificationsView()
            }
    }
}

extension View {
    /// 给一级页面挂上右上角 bell 按钮 + 跳转到 NotificationsView。
    /// `prominent: true` 用于沉浸式照片背景页（Home），bell 加 material 圆底。
    func ppBellToolbar(prominent: Bool = false) -> some View {
        modifier(PPBellToolbarModifier(prominent: prominent))
    }
}
