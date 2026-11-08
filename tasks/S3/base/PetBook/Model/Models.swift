//
//  Models.swift
//  PetBook
//
//  PetBook V1 数据模型（前端骨架阶段，纯内存 mock）。
//  字段口径对齐 PRD Section 6；后端 schema 落地前先用 Swift struct 走前端 UI 调试。
//

import Foundation
import SwiftUI       // ServiceTag.mapColor / themeColor 用 Color
import CoreLocation  // VetClinic.coordinate 用 CLLocationCoordinate2D
import CryptoKit     // VetClinic.stableUUID：把真实数据的 string id 派生成确定性 UUID

// MARK: - Enums

enum Species: String, Codable, CaseIterable, Identifiable {
    case dog, cat
    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .dog: String(localized: "Dog")
        case .cat: String(localized: "Cat")
        }
    }

    var emoji: String {
        switch self {
        case .dog: "🐶"
        case .cat: "🐱"
        }
    }
}

enum PetSex: String, Codable, CaseIterable, Identifiable {
    case male, female, unknown
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .male: String(localized: "Male")
        case .female: String(localized: "Female")
        case .unknown: String(localized: "Unknown")
        }
    }
}

enum ResidenceType: String, Codable, CaseIterable, Identifiable {
    case hdb, condo, landed
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .hdb: String(localized: "HDB")
        case .condo: String(localized: "Condo")
        case .landed: String(localized: "Landed")
        }
    }
}

enum VaccineType: String, Codable, CaseIterable, Identifiable {
    case dhppl = "DHPPL"
    case fvrcp = "FVRCP"
    case lepto = "Lepto"
    case rabies = "Rabies"
    case other = "Other"
    var id: String { rawValue }
}

enum DewormingKind: String, Codable, CaseIterable, Identifiable {
    case internalParasite = "internal"
    case external = "external"
    case heartworm = "heartworm"
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .internalParasite: String(localized: "Internal")
        case .external: String(localized: "External")
        case .heartworm: String(localized: "Heartworm")
        }
    }
}

enum ServiceTag: String, Codable, CaseIterable, Identifiable {
    // vet / petshop / boarding 对应 SG 政府 AVS 持牌名录；
    // grooming / photography 无政府名录，数据来自 admin 入驻或商家自注册；
    // emergency24h 不在 services 数组里，由 VetClinic.is24h 字段单独驱动。
    case vet, petshop, grooming, boarding, photography, emergency24h
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .vet: String(localized: "Vet")
        case .petshop: String(localized: "Pet shop")
        case .grooming: String(localized: "Grooming")
        case .boarding: String(localized: "Boarding")
        case .photography: String(localized: "Photography")
        case .emergency24h: String(localized: "24h Emergency")
        }
    }

    /// 地图 marker / 名片服务标签的 SF Symbol 图标。
    var mapIcon: String {
        switch self {
        case .vet:          "stethoscope"
        case .petshop:      "bag.fill"
        case .grooming:     "scissors"
        case .boarding:     "house.fill"
        case .photography:  "camera.fill"
        case .emergency24h: "cross.case.fill"
        }
    }

    /// 地图 marker / 服务标签的强色（24h 红色警示）。
    var mapColor: Color {
        switch self {
        case .vet:          .blue
        case .petshop:      .purple
        case .grooming:     .pink
        case .boarding:     .green
        case .photography:  .orange
        case .emergency24h: Color.ppDanger
        }
    }

    /// 名片大面积主题色（浅色克制柔和，归并为四大类：医疗 / 零售 / 寄养 / 生活服务）。
    var themeColor: Color {
        switch self {
        case .vet, .emergency24h:        .blue     // 医疗
        case .petshop:                   .purple   // 零售
        case .boarding:                  .green    // 寄养
        case .grooming, .photography:    .orange   // 生活服务
        }
    }
}

// MARK: - 诊所数据来源

enum ClinicSource: String, Codable, CaseIterable, Identifiable {
    case government       // SG 政府 AVS 持牌名录（管线自动导入）
    case selfRegistered   // 商家自主入驻
    case admin            // 运营手动录入
    var id: String { rawValue }
}

enum AppLanguage: String, Codable, CaseIterable, Identifiable {
    case en = "en"
    case zhHans = "zh-Hans"
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .en: "English"
        case .zhHans: "简体中文"
        }
    }
}

// MARK: - Core models

struct Owner: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var displayName: String = ""
    var email: String?
    var postalCode: String?
    var residenceType: ResidenceType?
    var primaryPhone: String?
    var emergencyContact: String?
    var language: AppLanguage = .en
    var hasLinkedAppleID: Bool = false
    /// POC（Pet Ownership Course）：AVS 要求每位「首次领猫或狗牌照」的主人一生完成一次的免费在线课。
    /// owner 级一次性资质（不分猫狗、不 per-pet）——完成后此人名下所有宠物的申牌前置即满足。
    /// 线格式 snake_case `poc_completed`；请求/响应 camelCase `pocCompleted`。
    var pocCompleted: Bool = false
}

struct Pet: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var ownerID: UUID
    var species: Species
    var name: String
    var breed: String?
    var sex: PetSex = .unknown
    var dob: Date?
    var microchipID: String?       // 15 位
    var sterilized: Bool?          // nil = Don't know（SG license 类型决策依据）
    /// @deprecated 已迁至 `Owner.pocCompleted`。POC 是「人」一生一次的资质（owner 级），非 per-pet。
    /// 保留此字段仅为兼容旧数据 decode，勿再读写它做 POC 判定。
    var pocCompleted: Bool?
    var avsLicenseID: String?
    var avsLicenseExpiry: Date?
    // 当前体重已收敛到 WeightRecord（一处真相）：取该 pet 最新一条体重记录。
    // 见 PetBookStore.currentWeight(for:)。后端 pets 表已无 current_weight_kg 列。
    var photoAssetName: String?    // mock 阶段引用 Assets 里的图（若有）
    /// Home 沉浸页背景图（与头像分离的独立资产，类似小红书头像/背景图，都可为空）。
    /// 远程 = 后端 object path（含 "/"，{owner}/{pet}-bg.jpg）；nil = 空状态背景（PPMeshBackground）。
    var backgroundAssetName: String? = nil
    var adoptionDate: Date?
    var createdAt: Date = .init()
}

struct VaccinationRecord: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var petID: UUID
    var vaccineType: VaccineType
    var administeredDate: Date
    var nextDueDate: Date?
    var brand: String?
    var batchNo: String?
    var vetClinicID: UUID?
    var notes: String?
}

struct DewormingRecord: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var petID: UUID
    var kind: DewormingKind
    var administeredDate: Date
    var nextDueDate: Date?
    var productName: String?
    var notes: String?
}

struct VetVisitRecord: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var petID: UUID
    var visitDate: Date
    var vetClinicID: UUID?
    var customClinicName: String?
    var vetName: String?
    var diagnosis: String?
    var notes: String?
    var followUpNeeded: Bool = false
    var followUpDate: Date?
}

struct WeightRecord: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var petID: UUID
    var recordedDate: Date
    var weightKg: Double
}

struct VetClinic: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    /// 后端原始 string id（如 "003b8e17dbed"）。`id` 是它经 MD5 派生的稳定 UUID（不可逆），
    /// 而众包回写 `POST /v1/clinics/:id/phone` 的 `:id` 认的是这个原始 string，故必须单独保留。
    /// bundle 兜底 / mock 数据无原始 string → 退回 `id.uuidString`（这些点本就不参与回写）。
    var rawId: String = ""
    var name: String
    var address: String
    var postalCode: String
    var latitude: Double
    var longitude: Double
    // 真实政府名录无 phone（用 MKLocalSearch 实时查）/ 无 whatsapp / 无 photo —— 三者均可选，默认 nil。
    var phone: String?
    var whatsapp: String?
    var services: [ServiceTag]
    var is24h: Bool = false
    // schemaVersion 2 新增（真实政府名录 v2）—— 均保留政府原始值，展示侧再映射成可读文字。
    var licenceNos: [String] = []        // AVS 牌照号数组：petshop/boarding 持有（双牌照店两个），兽医为 []
    var animalTypes: [String] = []       // 宠物店可售卖动物代码（D/C/SM/B/MF/F），非宠物店为 []
    var approvedActivity: String? = nil  // 寄养批准活动原文（如 "Pet Boarding (Cats & Dogs)"），非寄养为 nil
    var source: ClinicSource = .government  // 数据来源：政府名录 / 自主入驻 / admin 录入
    var imageName: String? = nil   // Assets/Clinics 下的图片名（如 "clinic-1"），nil 时用程序化占位
    // schemaVersion 4 新增（后端 enrich-google 管线采集，Google Places New API）——
    // matched=false 的店（Google 没匹配到）以下字段基本为空，UI 各自 nil 判空优雅降级。
    var placeId: String? = nil        // Google Place ID（deep link / 刷新键）
    var website: String? = nil        // 官网
    var hours: String? = nil          // 一周营业时间原文，" / " 连接（"Monday: 10:00 AM – 7:30 PM / Tuesday: …"）
    var placesPhone: String? = nil    // Google 电话·本地格式（≠ 众包 phone，两者并存、来源不同）
    var intlPhone: String? = nil      // Google 电话·国际格式（+65 …），拨号优先用（tel: 更稳）
    var rating: Double? = nil         // Google 评分
    var ratingCount: Int? = nil       // 评分人数（展示评分时必须一起带上，可信度基石）
    var mapsUrl: String? = nil        // Google Maps 链接（https://maps.google.com/?cid=…）
    var businessStatus: String? = nil // OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY（保留原文）
    var googleTypes: [String] = []    // 地点分类（恒为数组，可能空），如 ["pet_care","veterinary_care"]
    var matched: Bool = false         // Google 是否匹配到；false = 未匹配/未采集

    /// 展示用招牌名：去掉政府名录的公司法律后缀（Pte Ltd / LLP / Private Limited），更像店铺招牌。
    /// 产品负责人要求地图展示商店名而非公司注册名；原始 `name` 保留（MKLocalSearch 反查 / 法律实体追溯）。
    var displayName: String {
        let stripped = name.replacingOccurrences(
            of: #"\s*(?:PTE\.?\s*LTD\.?|LLP\.?|PRIVATE\s+LIMITED)\s*$"#,
            with: "", options: [.regularExpression, .caseInsensitive])
        let trimmed = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? name : trimmed
    }

    // 全字段构造器（mock 数据用；自定义 Codable 后系统不再自动合成 memberwise init）。
    init(id: UUID = .init(), name: String, address: String, postalCode: String,
         latitude: Double, longitude: Double, phone: String? = nil, whatsapp: String? = nil,
         services: [ServiceTag], is24h: Bool = false,
         licenceNos: [String] = [], animalTypes: [String] = [], approvedActivity: String? = nil,
         source: ClinicSource = .government, imageName: String? = nil,
         placeId: String? = nil, website: String? = nil, hours: String? = nil,
         placesPhone: String? = nil, intlPhone: String? = nil,
         rating: Double? = nil, ratingCount: Int? = nil, mapsUrl: String? = nil,
         businessStatus: String? = nil, googleTypes: [String] = [], matched: Bool = false) {
        self.id = id
        self.rawId = id.uuidString
        self.name = name
        self.address = address
        self.postalCode = postalCode
        self.latitude = latitude
        self.longitude = longitude
        self.phone = phone
        self.whatsapp = whatsapp
        self.services = services
        self.is24h = is24h
        self.licenceNos = licenceNos
        self.animalTypes = animalTypes
        self.approvedActivity = approvedActivity
        self.source = source
        self.imageName = imageName
        self.placeId = placeId
        self.website = website
        self.hours = hours
        self.placesPhone = placesPhone
        self.intlPhone = intlPhone
        self.rating = rating
        self.ratingCount = ratingCount
        self.mapsUrl = mapsUrl
        self.businessStatus = businessStatus
        self.googleTypes = googleTypes
        self.matched = matched
    }

    // MARK: - Codable（兼容真实政府名录 JSON：8 字段 envelope，无 phone/whatsapp/imageName）

    private enum CodingKeys: String, CodingKey {
        case id, name, address, postalCode, latitude, longitude
        case phone, whatsapp, services, is24h, imageName
        case licenceNos, animalTypes, approvedActivity
        case source
        // schemaVersion 4：Google 字段（与后端契约 camelCase 一一对应）
        case placeId, website, hours, placesPhone, intlPhone
        case rating, ratingCount, mapsUrl, businessStatus, googleTypes, matched
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        // 真实数据 id 是 string（如 "003b8e17dbed"）；本模型全工程用 UUID。
        // 用确定性映射把 string id 转成稳定 UUID（同一字符串每次得同一 UUID），
        // 既守住 UUID 类型、又保证刷新/重启后同一诊所 id 一致（去重、selection 不跳）。
        // 若 JSON 本身就是合法 UUID 字符串则原样用；否则走 MD5 派生（确定性）。
        let rawID = try c.decode(String.self, forKey: .id)
        self.id = Self.stableUUID(from: rawID)
        // 保留后端原始 string id：众包回写 POST /v1/clinics/:id/phone 用这个，不能用派生 UUID。
        self.rawId = rawID

        self.name = try c.decode(String.self, forKey: .name)
        self.address = try c.decode(String.self, forKey: .address)
        self.postalCode = try c.decode(String.self, forKey: .postalCode)
        self.latitude = try c.decode(Double.self, forKey: .latitude)
        self.longitude = try c.decode(Double.self, forKey: .longitude)

        // 真实数据没有这三个字段 → decodeIfPresent 兜底为 nil。
        self.phone = try c.decodeIfPresent(String.self, forKey: .phone)
        self.whatsapp = try c.decodeIfPresent(String.self, forKey: .whatsapp)
        self.imageName = try c.decodeIfPresent(String.self, forKey: .imageName)

        // services 是 string 数组（"vet"/"petshop"/"boarding"）→ 映射到 ServiceTag，未知值跳过。
        let rawServices = try c.decodeIfPresent([String].self, forKey: .services) ?? []
        self.services = rawServices.compactMap { ServiceTag(rawValue: $0) }

        self.is24h = try c.decodeIfPresent(Bool.self, forKey: .is24h) ?? false

        self.licenceNos = try c.decodeIfPresent([String].self, forKey: .licenceNos) ?? []
        self.animalTypes = try c.decodeIfPresent([String].self, forKey: .animalTypes) ?? []
        self.approvedActivity = try c.decodeIfPresent(String.self, forKey: .approvedActivity)
        self.source = try c.decodeIfPresent(ClinicSource.self, forKey: .source) ?? .government

        // schemaVersion 4：Google 字段全部 decodeIfPresent 兜底——
        // 老版 bundle（v2/v3，无这些键）与 matched=false 的店（键在但值 null）都优雅降级为 nil/[]/false。
        self.placeId = try c.decodeIfPresent(String.self, forKey: .placeId)
        self.website = try c.decodeIfPresent(String.self, forKey: .website)
        self.hours = try c.decodeIfPresent(String.self, forKey: .hours)
        self.placesPhone = try c.decodeIfPresent(String.self, forKey: .placesPhone)
        self.intlPhone = try c.decodeIfPresent(String.self, forKey: .intlPhone)
        self.rating = try c.decodeIfPresent(Double.self, forKey: .rating)
        self.ratingCount = try c.decodeIfPresent(Int.self, forKey: .ratingCount)
        self.mapsUrl = try c.decodeIfPresent(String.self, forKey: .mapsUrl)
        self.businessStatus = try c.decodeIfPresent(String.self, forKey: .businessStatus)
        self.googleTypes = try c.decodeIfPresent([String].self, forKey: .googleTypes) ?? []
        self.matched = try c.decodeIfPresent(Bool.self, forKey: .matched) ?? false
    }

    // MARK: - schemaVersion 2 展示派生（政府原始码 → 可读文字）

    /// 是否 AVS 持牌（petshop/boarding 有牌照号 → 政府正规登记，名片显示信任徽章）。
    var isAVSLicensed: Bool { !licenceNos.isEmpty }

    /// 把单个政府动物代码映射成可读英文（未知码原样返回，绝不吞）。
    /// nonisolated：纯字符串映射、无状态，供 `map` 等 nonisolated 同步上下文调用（项目默认 MainActor 隔离）。
    nonisolated static func animalTypeDisplayName(for code: String) -> String {
        switch code {
        case "D":  return "Dog"
        case "C":  return "Cat"
        case "SM": return "Small mammals"
        case "B":  return "Birds"
        case "MF": return "Marine fish"
        case "F":  return "Freshwater fish"
        default:   return code   // 政府名录若出新码，原样透出而非静默丢弃
        }
    }

    /// 宠物店可售卖动物的可读名数组（保持政府原始顺序），供名片 "Sells: …" 展示。
    var animalTypeDisplayNames: [String] {
        animalTypes.map(Self.animalTypeDisplayName)
    }

    /// 寄养范围（UI 层加工）：从政府原文 approvedActivity 抽括号内容，
    /// 如 "Pet Boarding (Cats & Dogs)" → "Cats & Dogs"，供名片胶囊 "Boards: …" 展示。
    /// 抽不到括号（政府原文格式将来变化）→ nil，胶囊退回显示分类名——不崩、不显示半截原文；
    /// 数据层 approvedActivity 本身保真不动。
    var boardingScope: String? {
        guard let approvedActivity,
              let match = approvedActivity.range(of: #"\(([^)]+)\)"#, options: .regularExpression)
        else { return nil }
        // match 是含括号的整段 "(…)"，去头尾括号取内文。
        let inner = approvedActivity[match].dropFirst().dropLast()
            .trimmingCharacters(in: .whitespaces)
        return inner.isEmpty ? nil : inner
    }

    // MARK: - schemaVersion 4 展示派生（Google 字段 → UI 可用形态）

    /// 歇业状态两档（businessStatus 非 OPERATIONAL 时 UI 显著标注）。
    enum ClosureKind {
        case temporary   // CLOSED_TEMPORARILY 临时歇业
        case permanent   // CLOSED_PERMANENTLY 永久歇业
    }

    /// 歇业状态：nil = 在营 / 未采集（不标注）。未知新枚举值不吞也不误标，一律当在营处理。
    var closure: ClosureKind? {
        switch businessStatus {
        case "CLOSED_TEMPORARILY": .temporary
        case "CLOSED_PERMANENTLY": .permanent
        default: nil
        }
    }

    /// 评分摘要 "4.8 (179)"：rating 与 ratingCount 必须成对展示（人数是可信度基石）。
    /// matched=false 或任一字段缺失 → nil（UI 不显示评分区，绝不显示无人数的裸分）。
    var ratingSummary: String? {
        guard matched, let rating, let ratingCount else { return nil }
        return String(format: "%.1f (%d)", rating, ratingCount)
    }

    /// 营业时间按天拆行（后端一周 7 行用 " / " 连接）；无数据为 []。
    var hoursLines: [String] {
        guard let hours, !hours.isEmpty else { return [] }
        return hours.components(separatedBy: " / ")
    }

    /// 今天的营业时间行（Google 行首恒为英文星期名，按系统当前 weekday 匹配）；无则 nil。
    var todayHoursLine: String? {
        let weekday = Calendar.current.component(.weekday, from: Date())   // 1=Sun … 7=Sat
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        let name = names[weekday - 1]
        return hoursLines.first { $0.hasPrefix(name) }
    }

    /// Google 来源的可拨电话：国际格式优先（tel: 更稳），退回本地格式。
    /// 与众包 phone 的优先级关系由 ClinicMapSheet 决定（众包 > Google > MKLocalSearch）。
    var googlePhone: String? {
        intlPhone ?? placesPhone
    }

    /// 地图坐标（经纬度组合）。
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// marker / 名片头部代表的主服务：24h 急诊优先，其次兽医，再退化到首个服务，全空兜底兽医图标。
    var primaryService: ServiceTag {
        if is24h { return .emergency24h }
        if services.contains(.vet) { return .vet }
        return services.first ?? .vet
    }

    /// 把任意字符串映射成确定性 UUID：合法 UUID 字符串原样用，否则用 MD5 前 16 字节构造。
    /// 确定性保证：同一诊所跨「bundle 解码」与「远端解码」得到同一 id（列表去重、selection 稳定）。
    static func stableUUID(from raw: String) -> UUID {
        if let direct = UUID(uuidString: raw) { return direct }
        let digest = Insecure.MD5.hash(data: Data(raw.utf8))
        let bytes = [UInt8](digest)   // MD5 = 16 bytes，正好填满 UUID
        // 这里不强制 RFC4122 版本位——只需确定性 + 唯一性，去重与 selection 已足够。
        let uuid = (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                    bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
        return UUID(uuid: uuid)
    }
}

struct BreedRule: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var breedName: String
    var species: Species
    var hdbApproved: Bool
    var specifiedDog: Bool = false
    var projectAdoreEligible: Bool = false
    var notes: String?
}

// MARK: - 到店服务（诊所可预约项目）

/// 诊所提供的可预约服务（看诊 / 疫苗 / 美容 / 洗牙 / 寄养等）。demo 阶段全局共用一份列表。
struct ClinicService: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var priceSGD: Int
    var durationMinutes: Int   // 0 = 不适用（如按晚计费的寄养）
    var blurb: String
    var icon: String           // SF Symbol
}

// MARK: - 诊所医生（多医生排班）

/// 诊所的兽医。每位有固定工作时段（星期 + 起止小时），向 app 开放供用户按可用时段预约。
struct Vet: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var clinicID: UUID
    var name: String
    var title: String              // 如 "Senior Veterinarian" / "Surgeon"
    var workingWeekdays: [Int]     // Calendar weekday：1=Sun … 7=Sat
    var startHour: Int             // 班次起始小时（含）
    var endHour: Int               // 班次结束小时（不含）→ 最后一个 slot 为 (endHour-1):00–endHour:00
    var bookedSlots: [Date] = []   // 已被其他患者占用的时段（mock 预置；用户自己的预约会再叠加占用）
    var photoAssetName: String? = nil  // Assets/Vets 下的头像名（如 "vet-1"），nil 时退化为姓名缩写

    /// 姓名缩写（无头像时的圆形 monogram）
    var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
    }
}

/// 某医生某天的一个可预约时段（1 小时粒度）。
struct TimeSlot: Identifiable, Hashable {
    let start: Date      // slot 起始（精确到小时）
    let isTaken: Bool    // 已被占用：同医生同时段已有未取消的预约
    var id: Date { start }
}

// MARK: - 预约（请求制状态卡，无二维码核销）

/// 预约状态机：提交 = Requested → 诊所确认 = Confirmed → 就诊后 = Completed；任意点可 Cancelled。
enum AppointmentStatus: String, Codable, CaseIterable {
    case requested, confirmed, completed, cancelled
}

/// 一次到店预约。凭证作用是状态追踪 + 提醒（非验票），故无二维码。
struct Appointment: Identifiable, Codable, Hashable {
    var id: UUID = .init()
    var reference: String           // 展示用预约号，如 "PP-7K3M"
    var clinicID: UUID
    var serviceID: String           // ClinicService.id
    var vetID: UUID?                // 预约的医生（多医生排班）
    var petID: UUID?                // 为哪只宠物预约
    var scheduledDate: Date         // 期望就诊时间
    var reason: String?             // 就诊原因
    var isNewPatient: Bool = false  // 是否首诊
    var status: AppointmentStatus = .requested
    var createdAt: Date = .init()
}
