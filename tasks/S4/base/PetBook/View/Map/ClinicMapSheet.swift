//
//  ClinicMapSheet.swift
//  PetBook
//
//  tap 地图 marker 后弹出的店铺名片（bottom sheet）。
//  布局：店名 → 歇业徽章（如有）→ Google 评分（如有）→ 服务胶囊（含政府细则："Sells: …"/"Boards: …"）
//       → 地址 → 营业时间（今天一行，可展开一周）→ Directions / Call → 官网 / Google Maps 链接。
//  Call / WhatsApp / Directions 走系统 URL scheme，零后端即真实可用。
//  （到店预约入口 bookButton 属阶段二，阶段一隐藏，代码留存；onBook 链路见 PRD §11.4。）
//

import SwiftUI
import MapKit
import CoreLocation

struct ClinicMapSheet: View {
    /// 用于众包回写电话（store.reportClinicPhone）。mock 模式无后端时回写内部自跳过。
    @Environment(PetBookStore.self) private var store

    let clinic: VetClinic
    let userLocation: CLLocation?
    /// 点 "Book appointment" 时回调：父级关闭名片并 push ClinicDetailView。
    /// 阶段二启用（到店预约入口，PRD §11.4）；阶段一 bookButton 隐藏，本回调暂不触发。
    let onBook: () -> Void

    @State private var showContactOptions = false
    /// 点店名旁的持牌徽章 → 弹出具体 AVS 牌照号 + 跳官网查验。
    @State private var showLicenceInfo = false
    /// 营业时间是否展开成一周 7 行（默认收起只显示今天）。
    @State private var showAllHours = false

    /// MKLocalSearch 实时查到的电话（政府名录无 phone、Google 也没采到时的最后手段）。
    /// nil = 尚未查到 / 查不到 → 不显示 Call 按钮（绝不编造假号码）。
    @State private var resolvedPhone: String?
    /// 是否正在查电话（用于占位，避免 Call 按钮闪现）。
    @State private var isResolvingPhone = false

    /// 最终可拨打的电话，三级优先：众包 phone（有人本地实测过）> Google 电话（intlPhone/placesPhone）
    /// > MKLocalSearch 实时反查。
    private var dialablePhone: String? {
        clinic.phone ?? clinic.googlePhone ?? resolvedPhone
    }

    var body: some View {
        ScrollView {
            VStack(spacing: PPSpacing.xl) {
                // 店名 + AVS 持牌徽章按钮：仅有可查验牌照号时显示（petshop/boarding 有，
                // 政府兽医名录未公布牌照号故 vet 无）。点击弹牌照号 + 跳 AVS 官网查验。
                HStack(alignment: .top, spacing: PPSpacing.xs) {
                    Text(clinic.displayName)
                        .font(.title2)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.leading)
                    // AVS 持牌徽章：全 544 家均来自政府持牌名录，故恒显绿色印章。
                    // 有牌照号（petshop/boarding）→ 可点弹号码 + 跳官网；
                    // 无号码（vet 名录未公布编号）→ 静态展示、不可点。
                    if clinic.licenceNos.isEmpty {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.title3)
                            .foregroundStyle(Color.ppSuccess)
                    } else {
                        Button {
                            showLicenceInfo = true
                        } label: {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.title3)
                                .foregroundStyle(Color.ppSuccess)
                        }
                        .popover(isPresented: $showLicenceInfo) {
                            licencePopover
                        }
                    }
                }

                // 歇业标注（schemaVersion 4 businessStatus）：临时=琥珀 / 永久=红，显著置顶。
                // 注：产品负责人 2026-07-11 拍板歇业店已在数据源层全局过滤（PetBookStore.displayable），
                // 正常链路永不触发。防御性保留：Preview 直接构造可调样式；将来「显示歇业店」开关直接可用。
                if let closure = clinic.closure {
                    closureBadge(closure)
                }

                // Google 评分：rating + ratingCount 成对展示（"4.8 (179)"），
                // matched=false 或无评分时 ratingSummary 为 nil → 整行不渲染。
                if let ratingSummary = clinic.ratingSummary {
                    HStack(spacing: 4) {
                        Image(systemName: "star.fill")
                            .foregroundStyle(.yellow)
                        Text(ratingSummary)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.ppTextPrimary)
                        Text("· Google")
                            .foregroundStyle(Color.ppTextSecondary)
                    }
                    .font(.subheadline)
                }

                // 服务胶囊（已合并政府细则，产品负责人 2026-07-11 拍板去重）：每个 service 一个胶囊，
                // petshop 带售卖种类 → "Sells: Dog · Cat"、boarding 带寄养范围 → "Boards: Cats & Dogs"，
                // 其余显示分类名。细则文本较长，双牌照店横排放不下时 ViewThatFits 自动退竖排。
                ViewThatFits {
                    HStack(spacing: PPSpacing.sm) { serviceChips }
                    VStack(spacing: PPSpacing.xs) { serviceChips }
                }

                VStack(spacing: PPSpacing.lg) {
                    Label("\(clinic.address) S(\(clinic.postalCode))", systemImage: "mappin.and.ellipse")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Color.ppTextSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .font(.subheadline)

                    // 营业时间（schemaVersion 4 hours）：默认只显示今天一行，点击展开一周 7 行。
                    if !clinic.hoursLines.isEmpty {
                        hoursSection
                    }
                }

                Divider()

                // bookButton（到店预约入口）属阶段二，阶段一隐藏（PRD §11.4）；
                // onBook 参数与 bookButton 计算属性保留，阶段二把本行加回即可。
                // Call 按钮仅在查到电话时出现（真实数据无 phone，靠 MKLocalSearch 实时反查），
                // 查不到则只剩 Directions（降级，不编假号码）。
                HStack(spacing: PPSpacing.sm) {
                    directionsButton
                    if dialablePhone != nil {
                        callButton
                    }
                }

                // Google 补充链接（schemaVersion 4）：官网 + 在 Google Maps 打开。
                // 均可选字段，全 nil（matched=false 等）时整行不渲染。
                if clinic.website != nil || clinic.mapsUrl != nil {
                    HStack(spacing: PPSpacing.xl) {
                        if let website = clinic.website {
                            linkChip(title: "Website", systemImage: "globe") { open(website) }
                        }
                        if let mapsUrl = clinic.mapsUrl {
                            linkChip(title: "Google Maps", systemImage: "map") { open(mapsUrl) }
                        }
                    }
                }

                // 真实政府名录无照片，imageName 为 nil 时不渲染图（避免 Image("") 空白占位）。
                if let imageName = clinic.imageName {
                    Image(imageName)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 24))
                }

                Spacer(minLength: 0)
            }
            .padding(.top, PPSpacing.xxxl)
            .padding(.top, PPSpacing.xl)
            .safeAreaPadding(.horizontal, PPSpacing.xl)
            .padding(.bottom, PPSpacing.lg)
        }
        .scrollIndicators(.hidden)
        .background(backgroundGradient.ignoresSafeArea())
        .background(Color.ppBackground.ignoresSafeArea())
        .confirmationDialog("Contact \(clinic.displayName)", isPresented: $showContactOptions, titleVisibility: .visible) {
            Button("Call") { callPhone() }
            Button("WhatsApp") { openWhatsApp() }
            Button("Cancel", role: .cancel) {}
        }
        .task(id: clinic.id) {
            ReviewManager.shared.recordMeaningfulAction()   // 看诊所名片 = 正向操作，计入评分触发
            await resolvePhoneIfNeeded()
        }
    }

    // MARK: - 名片背景（按主服务类型配一抹氛围渐变，iOS 17 安全：纯 LinearGradient）

    /// 三类诊所各配一套柔和氛围色：顶部一层该类型基色的淡晕 → 平滑过渡回品牌米白底。
    /// 基色取自主服务 `ServiceTag.themeColor`（医疗=蓝 / 零售=紫 / 寄养=绿）。
    /// 浅色克制不抢内容（对齐工程「浅色 only + 米白主色」基调）。
    /// 产品负责人微调点：三类主色改 `ServiceTag.themeColor`（MapView.swift）；晕染浓淡 / 高度调下方各 stop 的 opacity / location。
    private var backgroundGradient: LinearGradient {
        let tint = clinic.primaryService.themeColor
        return LinearGradient(
            stops: [
                .init(color: tint.opacity(0.2), location: 0.0),
                .init(color: tint.opacity(0.05), location: 0.5),
                .init(color: Color.ppBackground, location: 1.0)
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // MARK: - 电话解析（优先级：众包电话 > Google 电话 > 进程缓存 > MKLocalSearch 实时查 + 回写）

    /// 电话解析优先级：
    ///   1) clinic.phone（后端社区众包电话）非 nil → 直接用，跳过 MKLocalSearch
    ///      （已有人补过，不重复查 Apple Maps，也不重复回写）。
    ///   2) clinic.googlePhone（schemaVersion 4 的 intlPhone/placesPhone）非 nil → 直接用，
    ///      同样不查 Apple Maps、也不回写（后端本就有 Google 电话，众包列只留给人工实测号码）。
    ///   3) 本进程内存缓存命中（同一 app 会话内此前已查过该诊所）→ 直接用，不再查 Apple Maps。
    ///   4) 都没有 → MKLocalSearch 实时反查 → 查到后：① 显示 Call；② 回写后端（众包补齐，让别人不用再查）；
    ///      ③ 写进程缓存（本会话不再重复查）。
    /// 查询失败 / 无结果 / 无电话 → resolvedPhone 保持 nil → Call 按钮不出现（降级，绝不编造假号码）。
    private func resolvePhoneIfNeeded() async {
        // 1)+2) 已有众包电话或 Google 电话 → 无需任何反查 / 回写。
        guard clinic.phone == nil, clinic.googlePhone == nil,
              resolvedPhone == nil, !isResolvingPhone else { return }

        // 2) 进程缓存命中（本会话此前查过）→ 直接用，跳过 Apple Maps。
        if let cached = ClinicDirectoryService.cachedResolvedPhone(forRawId: clinic.rawId) {
            resolvedPhone = cached
            return
        }
        // 本会话此前已查过但没查到（缓存里无号码）→ 不再徒劳重查。
        if ClinicDirectoryService.hasTriedResolving(rawId: clinic.rawId) {
            return
        }

        // 3) 实时反查 Apple Maps。
        isResolvingPhone = true
        defer { isResolvingPhone = false }

        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = clinic.displayName
        // 把搜索范围收紧到诊所坐标附近（~1.5km），提高命中正确兴趣点的概率。
        request.region = MKCoordinateRegion(
            center: clinic.coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.015, longitudeDelta: 0.015)
        )

        let search = MKLocalSearch(request: request)
        guard let response = try? await search.start() else {
            // 查询本身失败（非「无结果」）：不写缓存——可能是临时网络问题，下次进名片可重试。
            return
        }

        // 取离诊所坐标最近的一个有电话的兴趣点（防同名店串号）。
        let target = CLLocation(latitude: clinic.latitude, longitude: clinic.longitude)
        let best = response.mapItems
            .filter { $0.phoneNumber != nil }
            .min { lhs, rhs in
                let l = lhs.placemark.location?.distance(from: target) ?? .greatestFiniteMagnitude
                let r = rhs.placemark.location?.distance(from: target) ?? .greatestFiniteMagnitude
                return l < r
            }
        let found = best?.phoneNumber
        resolvedPhone = found

        // 写进程缓存（含「查到」和「查无」两种结果：查无也记下，本会话不再重复查）。
        ClinicDirectoryService.cacheResolved(rawId: clinic.rawId, phone: found)

        // 查到了 → 众包回写后端（让其他用户 / 重装后复用，不必再查 Apple Maps）。
        if let found {
            await store.reportClinicPhone(rawClinicId: clinic.rawId, phone: found)
        }
    }

    // MARK: - 服务胶囊（分类 + 政府细则合并展示；AVS 持牌徽章在店名行 licencePopover 渲染）

    /// 每个 service 一个胶囊，沿用既有胶囊 UI（tag.mapIcon + tag.mapColor + 半透明胶囊底）。
    /// 文本由 chipText 决定：petshop/boarding 有政府细则时直接进胶囊，其余显示分类名。
    @ViewBuilder
    private var serviceChips: some View {
        HStack {
            ForEach(clinic.services) { tag in
                HStack(spacing: 4) {
                    Image(systemName: tag.mapIcon)
                    Text(chipText(for: tag))
                }
                .font(.subheadline)
                .foregroundStyle(tag.mapColor)
                .padding(.horizontal, PPSpacing.md)
                .padding(.vertical, PPSpacing.sm)
                .background(Capsule().fill(tag.mapColor.opacity(0.12)))
            }
        }
    }

    /// 胶囊文本规则：
    ///   • petshop 且有售卖种类 → "Sells: Dog · Cat"（可读名，· 分隔）
    ///   • boarding 且能抽到寄养范围（VetClinic.boardingScope 括号内文）→ "Boards: Cats & Dogs"
    ///   • 其余（vet / grooming / photography、或细则为空）→ 分类名
    private func chipText(for tag: ServiceTag) -> String {
        if tag == .petshop, !clinic.animalTypeDisplayNames.isEmpty {
            return "Sells: \(clinic.animalTypeDisplayNames.joined(separator: " · "))"
        }
        if tag == .boarding, let scope = clinic.boardingScope {
            return "Boards: \(scope)"
        }
        return tag.displayName
    }

    // MARK: - Google 数据展示（schemaVersion 4：歇业 / 营业时间 / 补充链接）

    /// 歇业徽章：临时歇业 = 琥珀（还有回来的可能），永久歇业 = 红（ppDanger，别再跑一趟）。
    private func closureBadge(_ closure: VetClinic.ClosureKind) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(closure == .permanent ? "Permanently closed" : "Temporarily closed")
        }
        .font(.footnote)
        .fontWeight(.semibold)
        .foregroundStyle(.white)
        .padding(.horizontal, PPSpacing.md)
        .padding(.vertical, PPSpacing.xs)
        .background(Capsule().fill(closure == .permanent ? Color.ppDanger : Color.ppWarning))
    }

    /// 营业时间：收起态显示「Today · 今天时段」，点击展开一周 7 行（今天加粗）。
    private var hoursSection: some View {
        VStack(spacing: PPSpacing.sm) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { showAllHours.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text(collapsedHoursText)
                    Image(systemName: "chevron.down")
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(showAllHours ? 180 : 0))
                    Spacer()
                }
                .font(.subheadline)
                .foregroundStyle(Color.ppTextSecondary)
            }
            .buttonStyle(.plain)

            if showAllHours {
                VStack(alignment: .leading, spacing: PPSpacing.sm) {
                    ForEach(clinic.hoursLines, id: \.self) { line in
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .opacity(0)
                            Text(line)
                                .font(.subheadline)
                                .fontWeight(line == clinic.todayHoursLine ? .semibold : .regular)
                                .foregroundStyle(line == clinic.todayHoursLine
                                                 ? Color.ppTextPrimary : Color.ppTextSecondary)
                            Spacer()
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 收起态文案："Today · 10:00 AM – 7:30 PM"（去掉星期前缀）；匹配不到今天行时退回 "Opening hours"。
    private var collapsedHoursText: String {
        guard let today = clinic.todayHoursLine else { return "Opening hours" }
        // Google 行格式恒为 "Monday: 10:00 AM – 7:30 PM"，取冒号后的时段部分。
        if let range = today.range(of: ": ") {
            return "Today · \(today[range.upperBound...])"
        }
        return today
    }

    /// 轻量文字链接 chip（官网 / Google Maps）：主色 + 图标，不与主 CTA 抢视觉。
    private func linkChip(title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                Text(title)
                Image(systemName: "arrow.up.right")
                    .font(.caption2)
            }
            .font(.subheadline)
            .foregroundStyle(Color.secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: - CTAs

    private var callButton: some View {
        PPSecondaryButton(title: "Call", systemImage: "phone.fill") {
            // 有 WhatsApp（mock 数据）时让用户选联系方式，否则直接拨号
            if clinic.whatsapp != nil {
                showContactOptions = true
            } else {
                callPhone()
            }
        }
    }

    /// 阶段二启用：到店预约入口（PRD §11.4）。阶段一 body 不引用，保留备阶段二恢复。
    private var bookButton: some View {
        PPPrimaryButton(title: "Book appointment", systemImage: "calendar.badge.plus") {
            onBook()
        }
    }

    private var directionsButton: some View {
        PPSecondaryButton(title: "Directions", systemImage: "arrow.triangle.turn.up.right.diamond.fill") {
            let item = MKMapItem(placemark: MKPlacemark(coordinate: clinic.coordinate))
            item.name = clinic.displayName
            item.openInMaps(launchOptions: [
                MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving
            ])
        }
    }

    // MARK: - Helpers

    private var distanceText: String? {
        guard let userLocation else { return nil }
        let d = userLocation.distance(from: CLLocation(latitude: clinic.latitude, longitude: clinic.longitude))
        return d < 1000 ? "\(Int(d)) m away" : String(format: "%.1f km away", d / 1000)
    }

    private func open(_ string: String) {
        guard let url = URL(string: string) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - AVS 持牌弹窗（点店名旁徽章触发）

    /// 弹出该店 AVS 牌照号（双牌照店两个）+ 跳官网查验。仅 petshop/boarding 有牌照号。
    @ViewBuilder
    private var licencePopover: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            Label("AVS Licensed", systemImage: "checkmark.seal.fill")
                .font(.headline)
                .foregroundStyle(Color.ppSuccess)
            VStack(alignment: .leading, spacing: PPSpacing.xs) {
                ForEach(clinic.licenceNos, id: \.self) { lic in
                    Text(lic)
                        .font(.subheadline)
                        .fontDesign(.monospaced)
                        .foregroundStyle(Color.ppTextPrimary)
                        .textSelection(.enabled)
                }
            }
            Button {
                openAVSRegistry(for: clinic.licenceNos.first ?? "")
            } label: {
                Label("View on AVS registry", systemImage: "arrow.up.right.square")
                    .font(.subheadline)
            }
        }
        .padding(PPSpacing.lg)
        .frame(minWidth: 220, alignment: .leading)
        .presentationCompactAdaptation(.popover)
    }

    /// 跳 AVS 官方持牌名录页（按牌照前缀：BD=寄养名录，AS=宠物店名录）。
    private func openAVSRegistry(for licence: String) {
        let petShops = "https://avs.nparks.gov.sg/outreach/resources/public-registry-of-avs-licensed-pet-shops/"
        let boarding = "https://avs.nparks.gov.sg/outreach/resources/public-registry-of-avs-licensed-pet-boarding-facilities/"
        open(licence.hasPrefix("BD") ? boarding : petShops)
    }

    private func callPhone() {
        guard let phone = dialablePhone else { return }
        open("tel:\(phone.filter { $0.isNumber || $0 == "+" })")
    }

    private func openWhatsApp() {
        guard let wa = clinic.whatsapp else { return }
        open("https://wa.me/\(wa.filter(\.isNumber))")
    }
}

#if DEBUG
// MARK: - Preview 调试样例（bundle 真实数据驱动，覆盖 v4 各形态，便于 Canvas 调名片 UI）

/// 把名片包进 sheet + 给个用户坐标（让距离文案显示），便于 Canvas 逐分类调样式。
private func clinicSheetPreview(_ clinic: VetClinic) -> some View {
    Color.ppBackground
        .sheet(isPresented: .constant(true)) {
            ClinicMapSheet(
                clinic: clinic,
                userLocation: CLLocation(latitude: 1.3048, longitude: 103.8318),
                onBook: {}
            )
            .presentationDetents([.fraction(0.45)])
            .presentationDragIndicator(.visible)
        }
        // ClinicMapSheet 依赖 @Environment(PetBookStore.self)（众包回写）；Preview 注入 mock store。
        .environment(PetBookStore())
}

/// Preview 数据源 = bundle 的 Resource/clinics.json（v4 真实快照），不手工造 mock（产品负责人 2026-07-11 指示）。
/// 快照含全部 313 家——歇业店也在（PetBookStore.displayable 过滤是运行时的，不影响直接读 JSON），
/// 故各形态样例都能拿到真实店。解码一次全 Preview 共用。
private let previewClinics = ClinicDirectoryService.loadBundled()

/// 按后端原始 id 挑真实店；店家将来从名录消失时按条件兜底取第一家，再缺退 mock 首店，绝不崩 Canvas。
private func previewClinic(id rawId: String, or fallback: (VetClinic) -> Bool) -> VetClinic {
    previewClinics.first { $0.rawId == rawId }
        ?? previewClinics.first(where: fallback)
        ?? VetClinic.mocks[0]
}

// 真实店样例（id = clinics.json 的原始 id；fallback 条件描述该样例要覆盖的形态）
#Preview("Google 全字段·在营") {   // Hello Human Wellness East：评分 4.8(179) + 7 天营业时间 + 官网 + Google 电话
    clinicSheetPreview(previewClinic(id: "01c472786e36") { $0.ratingSummary != nil && $0.hours != nil && $0.website != nil })
}
#Preview("matched=false 降级") {   // CATDERLAND：Google 未匹配，11 字段全空 → 名片与 v2 时代一致
    clinicSheetPreview(previewClinic(id: "046dc509f416") { !$0.matched })
}
#Preview("临时歇业（琥珀）") {      // PUPPY KINGDOM（防御性徽章：正常链路已被数据源过滤）
    clinicSheetPreview(previewClinic(id: "275be3ea3a80") { $0.closure == .temporary })
}
#Preview("永久歇业（红）") {        // Pooch Nannies
    clinicSheetPreview(previewClinic(id: "b36dd8a0f000") { $0.closure == .permanent })
}
#Preview("纯兽医") {               // COMPANION ANIMAL SURGERY：无政府三字段块（兼 24h 店）
    clinicSheetPreview(previewClinic(id: "040730e39039") { $0.services == [.vet] })
}
#Preview("宠物店·有售卖种类") {     // PUPPYLAND SG：持牌徽章 + "Sells: …"
    clinicSheetPreview(previewClinic(id: "04d66b90ef8a") { $0.services.contains(.petshop) && !$0.animalTypes.isEmpty })
}
#Preview("双牌照店") {             // DIAMOND WINGS HOLDING：petshop + boarding 双牌照
    clinicSheetPreview(previewClinic(id: "412c085a290e") { $0.licenceNos.count >= 2 })
}
#endif
