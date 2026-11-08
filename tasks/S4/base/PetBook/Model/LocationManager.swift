//
//  LocationManager.swift
//  PetBook
//
//  CLLocationManager 的轻量 @Observable 包装，给 Map 页面用。
//  暴露 UI 关心的三样：授权状态、最近一次定位、hasLocation 便利标志。
//  在 App 入口通过 .environment 注入，View 用 @Environment(LocationManager.self) 取。
//
//  ⚠️ 定位生效需要 Info.plist 的 NSLocationWhenInUseUsageDescription。本项目
//     GENERATE_INFOPLIST_FILE=YES 自动生成 Info.plist，需产品负责人在 Xcode Target →
//     Info（或 Build Settings 搜 "Location When In Use"）添加该描述，否则系统
//     不弹权限框、hasLocation 恒为 false（Map 降级为无距离 + 提示 banner，不崩溃）。
//

import Foundation
import CoreLocation
import Observation

@Observable
@MainActor
final class LocationManager: NSObject {

    private let manager = CLLocationManager()

    /// 当前授权状态，由 delegate 回调同步，供 SwiftUI 响应。
    var authorizationStatus: CLAuthorizationStatus = .notDetermined

    /// 最近一次 GPS 定位；拒绝授权 / 定位服务关 / 尚未拿到 fix 时为 nil。
    var currentLocation: CLLocation?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        authorizationStatus = manager.authorizationStatus
    }

    /// 弹系统权限框。幂等——iOS 每次安装只弹一次，后续调用 no-op。
    func requestPermission() {
        manager.requestWhenInUseAuthorization()
    }

    /// 持有有效坐标时为 true。View 据此在"显示距离"与"提示开启定位"间切换。
    var hasLocation: Bool {
        guard currentLocation != nil else { return false }
        return authorizationStatus == .authorizedWhenInUse
            || authorizationStatus == .authorizedAlways
    }
}

// MARK: - CLLocationManagerDelegate

extension LocationManager: CLLocationManagerDelegate {

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let newStatus = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationStatus = newStatus
            if newStatus == .authorizedWhenInUse || newStatus == .authorizedAlways {
                manager.startUpdatingLocation()
            } else {
                manager.stopUpdatingLocation()
                self.currentLocation = nil
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in
            self.currentLocation = location
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // 静默失败 — 用户侧信号是 hasLocation=false 时 view 渲染的"开启定位"提示。
    }
}
