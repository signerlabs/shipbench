//
//  MapView.swift
//  PetBook
//
//  找身边的宠物服务店（兽医 / 宠物店 / 寄养 / 24h 急诊）。真实政府名录 544 家诊所。
//  地图 / 列表双视图（顶部 toggle）：
//    • 地图：MapKit 全屏，按 service 染色的圆形 marker，24h 店加红色脉冲强调。
//    • 列表：原生 List，按用户当前位置直线距离升序，每行显示名 + 距离 + 服务 tag + 24h。
//  顶部服务筛选 chip（All / Vet / 24h / Pet shop / Boarding）同时作用于地图与列表。
//  tap marker / list row → ClinicMapSheet 名片（信息 + Directions + MKLocalSearch 实时查电话）。
//  CoreLocation 优雅降级：缺权限时显示提示 banner、列表退回原顺序，地图本身照常可用。
//  （到店预约 push ClinicDetailView 属阶段二：阶段一名片隐藏 Book 按钮即不触发，链路代码留存。）
//

import SwiftUI
import MapKit
import CoreLocation

struct MapView: View {
    @Environment(PetBookStore.self) private var store
    @Environment(LocationManager.self) private var locationManager
    // 相机状态托管在全局 controller，使切走 Map 再回来不重置（MapView 是条件渲染会销毁重建）。
    @Environment(PetBookTabBarController.self) private var tabBar

    @State private var selectedClinic: VetClinic?
    @State private var clinicToPush: VetClinic?

    /// 当前视图模式（地图 / 列表）。
    @State private var viewMode: ViewMode = .map
    /// 当前服务筛选。
    @State private var filter: ClinicFilter = .all

    enum ViewMode: String, CaseIterable {
        case map, list
    }

    /// 新加坡全岛俯瞰，初始 framing。
    static let islandRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 1.3521, longitude: 103.8198),
        span: MKCoordinateSpan(latitudeDelta: 0.35, longitudeDelta: 0.35)
    )

    // MARK: - 派生数据

    /// 经服务筛选后的诊所（地图与列表同源）。
    private var filteredClinics: [VetClinic] {
        store.vetClinics.filter { filter.matches($0) }
    }

    /// 列表用：有定位时按直线距离升序，无定位时保持原顺序。
    private var sortedClinics: [VetClinic] {
        guard let userLocation = locationManager.currentLocation else {
            return filteredClinics
        }
        return filteredClinics.sorted {
            userLocation.distance(from: CLLocation(latitude: $0.latitude, longitude: $0.longitude))
                < userLocation.distance(from: CLLocation(latitude: $1.latitude, longitude: $1.longitude))
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            // 地图 / 列表二选一渲染（地图保留 cameraPosition 状态，仅靠 opacity 切换会浪费内存，故条件渲染）
            switch viewMode {
            case .map:  mapContent
            case .list: listContent
            }

            // 无定位提示 banner 直接叠在 ZStack 顶部（不再走 topControls / safeAreaInset）。
            if !locationManager.hasLocation {
                LocationPermissionBanner(
                    status: locationManager.authorizationStatus,
                    onTap: handlePermissionBannerTap
                )
                .padding(.horizontal, PPSpacing.lg)
                .padding(.top, PPSpacing.sm)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .ppShowsRootTabBar()
        .sheet(item: $selectedClinic) { clinic in
            ClinicMapSheet(clinic: clinic, userLocation: locationManager.currentLocation, onBook: {
                // 阶段二启用：先关名片，再 push ClinicDetailView 到 Map 的 NavigationStack（sheet 内无法直达外层 stack）。
                // 阶段一名片隐藏 Book 按钮，本闭包不触发；clinicToPush / navigationDestination 保留备阶段二。
                selectedClinic = nil
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(300))
                    clinicToPush = clinic
                }
            })
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .navigationDestination(item: $clinicToPush) { clinic in
            ClinicDetailView(clinic: clinic)
        }
        .task {
            if locationManager.authorizationStatus == .notDetermined {
                locationManager.requestPermission()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Picker("View", selection: $viewMode.animation(.easeInOut(duration: 0.25))) {
                    Label("Map", systemImage: "map").tag(ViewMode.map)
                    Label("List", systemImage: "list.bullet").tag(ViewMode.list)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Filter", selection: $filter) {
                        ForEach(ClinicFilter.allCases) { f in
                            Label(f.displayName, systemImage: f.icon).tag(f)
                        }
                    }
                } label: {
                    Label(filter.displayName, systemImage: "line.3.horizontal.decrease.circle")
                }
            }
        }
    }

    // MARK: - 地图视图

    private var mapContent: some View {
        @Bindable var tabBar = tabBar
        return Map(position: $tabBar.mapCameraPosition) {
            ForEach(filteredClinics) { clinic in
                Annotation(clinic.displayName, coordinate: clinic.coordinate) {
                    ClinicMarker(clinic: clinic, isSelected: selectedClinic?.id == clinic.id)
                        .onTapGesture { selectedClinic = clinic }
                }
                .annotationTitles(.hidden)
            }
            UserAnnotation()
        }
        .mapStyle(.standard)
        // 系统标准地图控件：「定位到用户」按钮（自动处理定位权限 + 跟随），取代旧的自定义 MapActionButton。
        .mapControls {
            MapUserLocationButton()
        }
        .ignoresSafeArea(edges: .bottom)
        .task {
            // 首次进 Map 自动聚焦用户（标志在全局 controller，app 生命周期内只触发一次）；
            // 之后切走再回来 mapDidInitialZoom 已 true → 不再自动定位，保留用户拖动后的镜头。
            guard !tabBar.mapDidInitialZoom else { return }
            tabBar.mapDidInitialZoom = true
            try? await Task.sleep(for: .milliseconds(800))
            withAnimation(.easeInOut(duration: 1.2)) {
                let center = locationManager.currentLocation?.coordinate
                    ?? Self.islandRegion.center
                tabBar.mapCameraPosition = .region(MKCoordinateRegion(
                    center: center,
                    span: MKCoordinateSpan(latitudeDelta: 0.06, longitudeDelta: 0.06)
                ))
            }
        }
    }

    // MARK: - 列表视图（原生 List，按距离升序）

    private var listContent: some View {
        Group {
            if sortedClinics.isEmpty {
                ContentUnavailableView(
                    "No clinics",
                    systemImage: "mappin.slash",
                    description: Text("No clinics match this filter.")
                )
            } else {
                List {
                    if !locationManager.hasLocation {
                        Text("Enable location to sort by distance.")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                    ForEach(sortedClinics) { clinic in
                        Button {
                            selectedClinic = clinic
                        } label: {
                            ClinicListRow(
                                clinic: clinic,
                                distanceText: distanceText(for: clinic)
                            )
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.ppSurface)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Color.ppBackground)
            }
        }
    }

    /// 单家诊所相对用户当前位置的距离文案（无定位 → nil）。
    private func distanceText(for clinic: VetClinic) -> String? {
        guard let userLocation = locationManager.currentLocation else { return nil }
        let d = userLocation.distance(from: CLLocation(latitude: clinic.latitude, longitude: clinic.longitude))
        return d < 1000 ? "\(Int(d)) m" : String(format: "%.1f km", d / 1000)
    }

    // MARK: - 交互

    private func handlePermissionBannerTap() {
        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestPermission()
        case .denied, .restricted:
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
        default:
            break
        }
    }

}

// MARK: - 服务筛选维度

enum ClinicFilter: String, CaseIterable, Identifiable {
    case all, vet, emergency24h, petshop, boarding, grooming, photography
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .all:          String(localized: "All")
        case .vet:          String(localized: "Vet")
        case .emergency24h: String(localized: "24h")
        case .petshop:      String(localized: "Pet shop")
        case .boarding:     String(localized: "Boarding")
        case .grooming:     String(localized: "Grooming")
        case .photography:  String(localized: "Photo")
        }
    }

    var icon: String {
        switch self {
        case .all:          "square.grid.2x2"
        case .vet:          ServiceTag.vet.mapIcon
        case .emergency24h: ServiceTag.emergency24h.mapIcon
        case .petshop:      ServiceTag.petshop.mapIcon
        case .boarding:     ServiceTag.boarding.mapIcon
        case .grooming:     ServiceTag.grooming.mapIcon
        case .photography:  ServiceTag.photography.mapIcon
        }
    }

    var tint: Color {
        switch self {
        case .all:          .ppPrimary
        case .vet:          ServiceTag.vet.mapColor
        case .emergency24h: ServiceTag.emergency24h.mapColor
        case .petshop:      ServiceTag.petshop.mapColor
        case .boarding:     ServiceTag.boarding.mapColor
        case .grooming:     ServiceTag.grooming.mapColor
        case .photography:  ServiceTag.photography.mapColor
        }
    }

    func matches(_ clinic: VetClinic) -> Bool {
        switch self {
        case .all:          true
        case .vet:          clinic.services.contains(.vet)
        case .emergency24h: clinic.is24h
        case .petshop:      clinic.services.contains(.petshop)
        case .boarding:     clinic.services.contains(.boarding)
        case .grooming:     clinic.services.contains(.grooming)
        case .photography:  clinic.services.contains(.photography)
        }
    }
}

// MARK: - 列表行（名 + 距离 + 服务 tag + 24h 标记）

private struct ClinicListRow: View {
    let clinic: VetClinic
    let distanceText: String?

    var body: some View {
        HStack(spacing: PPSpacing.md) {
            // 主服务圆形图标
            Image(systemName: clinic.primaryService.mapIcon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(clinic.primaryService.mapColor))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(clinic.displayName)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                        .lineLimit(1)
                    // AVS 持牌小勾（schemaVersion 2）：全 544 家均来自政府持牌名录，故所有诊所恒显，
                    // 与名片口径统一（名片徽章亦全显；有牌照号者可点查号）。列表只放这枚最轻量的信任标识。
                    Image(systemName: "checkmark.seal.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.ppSuccess)
                }

                HStack(spacing: PPSpacing.xs) {
                    // 歇业小标（schemaVersion 4 businessStatus）：临时=琥珀 / 永久=红，先于一切标签。
                    // 注：歇业店已在数据源层全局过滤（PetBookStore.displayable），正常永不触发；防御性保留。
                    if let closure = clinic.closure {
                        Text("Closed")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(closure == .permanent ? Color.ppDanger : Color.ppWarning))
                    }
                    // Google 评分（rating + ratingCount 成对，nil 时不占位）
                    if let ratingSummary = clinic.ratingSummary {
                        HStack(spacing: 2) {
                            Image(systemName: "star.fill")
                                .font(.caption2)
                                .foregroundStyle(.yellow)
                            Text(ratingSummary)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(Color.ppTextSecondary)
                        }
                    }
                    if clinic.is24h {
                        Text("24h")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.ppDanger))
                    }
                    ForEach(clinic.services) { tag in
                        Text(tag.displayName)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(tag.mapColor)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(tag.mapColor.opacity(0.12)))
                    }
                }
            }

            Spacer(minLength: PPSpacing.xs)

            if let distanceText {
                VStack(spacing: 2) {
                    Image(systemName: "location.fill")
                        .font(.caption2)
                        .foregroundStyle(Color.ppTextSecondary)
                    Text(distanceText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.ppTextSecondary)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
    }
}

// MARK: - 圆形彩色 marker（24h 店带红色脉冲）

private struct ClinicMarker: View {
    let clinic: VetClinic
    let isSelected: Bool

    var body: some View {
        ZStack {
            if clinic.is24h {
                TimelineView(.animation) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    let phase = (sin(t * 2.2) + 1) / 2   // 0…1 确定性脉冲
                    Circle()
                        .stroke(Color.ppDanger.opacity(0.9 - phase * 0.8), lineWidth: 2.5)
                        .frame(width: 36, height: 36)
                        .scaleEffect(1 + phase * 0.2)
                }
            }

            Image(systemName: clinic.primaryService.mapIcon)
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(clinic.primaryService.mapColor))
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
        }
        .scaleEffect(isSelected ? 1.15 : 1.0)
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: isSelected)
    }
}

// MARK: - 定位权限提示 banner（无定位 fix 时浮在顶部）

private struct LocationPermissionBanner: View {
    let status: CLAuthorizationStatus
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: PPSpacing.sm) {
                Image(systemName: iconName)
                    .font(.subheadline.weight(.semibold))
                Text(copy)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                if showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .opacity(0.6)
                }
            }
            .foregroundStyle(Color.ppTextPrimary)
            .padding(.horizontal, PPSpacing.md)
            .padding(.vertical, PPSpacing.sm + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Capsule().fill(Color.ppSurface))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
        }
        .buttonStyle(.plain)
        .allowsHitTesting(showsChevron)
    }

    private var iconName: String {
        switch status {
        case .denied, .restricted: "location.slash.fill"
        case .notDetermined:       "location.circle"
        default:                   "location"
        }
    }

    private var copy: String {
        switch status {
        case .notDetermined: "Tap to enable location for nearby clinics"
        case .denied, .restricted: "Enable location in Settings to see distances"
        default: "Locating you…"
        }
    }

    private var showsChevron: Bool {
        switch status {
        case .notDetermined, .denied, .restricted: true
        default: false
        }
    }
}

#Preview {
    NavigationStack { MapView() }
        .environment(PetBookStore())
        .environment(PetBookTabBarController())
        .environment(LocationManager())
}
