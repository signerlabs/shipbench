//
//  PetDTO.swift
//  PetBook
//
//  网络层的 pet 数据传输对象（DTO），负责在「后端线格式」与「本地 Pet model」间双向翻译。
//
//  大小写不对称（与后端 zod / Supabase 行约定一致）：
//    • 请求 body（create / update）→ camelCase（后端 zod schema 收 camelCase）
//    • 响应 row（PetRow）        → snake_case（DB 物理列名）
//  因此请求与响应各用一套结构，不共享 CodingKeys。
//
//  类型映射：后端 uuid 列是字符串 → 本地 Pet.id / ownerID 是 UUID；
//  date 列是 ISO-8601 / yyyy-MM-dd 字符串 → 本地是 Date。映射在本文件集中处理。
//

import Foundation

// MARK: - 响应：PetRow（snake_case，DB 行）

/// 后端返回的单只宠物行。字段全为 snake_case，对应 Postgres 物理列。
/// 用 JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase 时，可声明 camelCase 属性自动匹配；
/// 这里显式写 snake_case CodingKeys，避免依赖全局策略、与请求侧解码器隔离，语义更清晰。
struct PetRow: Decodable {
    let id: String
    let ownerId: String
    let species: String
    let name: String
    let breed: String?
    let sex: String?
    let dob: String?               // yyyy-MM-dd
    let microchipId: String?
    let sterilized: Bool?
    let pocCompleted: Bool?
    let avsLicenseId: String?
    let avsLicenseExpiry: String?  // yyyy-MM-dd
    let photoPath: String?
    let backgroundPath: String?
    let adoptionDate: String?      // yyyy-MM-dd
    let createdAt: String?         // ISO-8601 timestamptz
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case ownerId = "owner_id"
        case species
        case name
        case breed
        case sex
        case dob
        case microchipId = "microchip_id"
        case sterilized
        case pocCompleted = "poc_completed"
        case avsLicenseId = "avs_license_id"
        case avsLicenseExpiry = "avs_license_expiry"
        case photoPath = "photo_path"
        case backgroundPath = "background_path"
        case adoptionDate = "adoption_date"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    /// 把后端行翻译成本地 Pet model。
    /// id / owner_id 无法解析成 UUID 时退化为新 UUID（极端容错，正常不会发生——后端是 uuid 列）。
    func toPet() -> Pet {
        Pet(
            id: UUID(uuidString: id) ?? UUID(),
            ownerID: UUID(uuidString: ownerId) ?? UUID(),
            species: Species(rawValue: species) ?? .dog,
            name: name,
            breed: breed,
            sex: sex.flatMap(PetSex.init(rawValue:)) ?? .unknown,
            dob: PetDateFormat.day.date(from: dob),
            microchipID: microchipId,
            sterilized: sterilized,
            pocCompleted: pocCompleted,
            avsLicenseID: avsLicenseId,
            avsLicenseExpiry: PetDateFormat.day.date(from: avsLicenseExpiry),
            photoAssetName: photoPath,
            // background_path 与 photo_path 同模式：只由背景上传端点落库，本 DTO 只读回
            backgroundAssetName: backgroundPath,
            adoptionDate: PetDateFormat.day.date(from: adoptionDate),
            createdAt: PetDateFormat.iso.date(from: createdAt) ?? Date()
        )
    }
}

/// 列表响应外壳：{ "pets": [PetRow...] }
struct PetListResponse: Decodable {
    let pets: [PetRow]
}

/// 单条响应外壳：{ "pet": PetRow }（create / update 返回）
struct PetResponse: Decodable {
    let pet: PetRow
}

/// 删除响应外壳：{ "deleted": "<id>" }
struct PetDeleteResponse: Decodable {
    let deleted: String
}

// MARK: - 请求：PetPayload（camelCase，写入 body）

/// 创建 / 更新 pet 的请求体。camelCase 字段直接走 JSONEncoder 默认即可。
/// 全部 Optional：create 时填齐必填（species/name），update 时只填要改的字段（后端做 partial）。
/// encode 时跳过 nil（encodeIfPresent），避免把 update 的未改字段误置空。
struct PetPayload: Encodable {
    var species: String?
    var name: String?
    var breed: String?
    var sex: String?
    var dob: String?               // yyyy-MM-dd
    var microchipId: String?
    var sterilized: Bool?
    var pocCompleted: Bool?
    var avsLicenseId: String?
    var avsLicenseExpiry: String?  // yyyy-MM-dd
    var photoPath: String?
    var adoptionDate: String?      // yyyy-MM-dd

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(species, forKey: .species)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(breed, forKey: .breed)
        try c.encodeIfPresent(sex, forKey: .sex)
        try c.encodeIfPresent(dob, forKey: .dob)
        try c.encodeIfPresent(microchipId, forKey: .microchipId)
        try c.encodeIfPresent(sterilized, forKey: .sterilized)
        try c.encodeIfPresent(pocCompleted, forKey: .pocCompleted)
        try c.encodeIfPresent(avsLicenseId, forKey: .avsLicenseId)
        try c.encodeIfPresent(avsLicenseExpiry, forKey: .avsLicenseExpiry)
        try c.encodeIfPresent(photoPath, forKey: .photoPath)
        try c.encodeIfPresent(adoptionDate, forKey: .adoptionDate)
    }

    enum CodingKeys: String, CodingKey {
        case species, name, breed, sex, dob
        case microchipId, sterilized, pocCompleted
        case avsLicenseId, avsLicenseExpiry
        case photoPath, adoptionDate
    }

    /// 从本地 Pet 构造完整 payload（用于 create —— 带全部已填字段）。
    /// 注意：**不传 photoPath**。photo_path 是后端在照片上传端点（POST /v1/pets/{id}/photo）落库后
    /// 才生成的真实 object path；客户端创建时既没有 pet_id 也没有 object，传任何值都是错的。
    /// 历史 bug：曾把 UI 占位串 "user-selected" 当 photoPath 上传，导致 photo_path 落库成假路径、头像永远空白。
    static func create(from pet: Pet) -> PetPayload {
        PetPayload(
            species: pet.species.rawValue,
            name: pet.name,
            breed: pet.breed,
            sex: pet.sex == .unknown ? nil : pet.sex.rawValue,
            dob: PetDateFormat.day.string(from: pet.dob),
            microchipId: pet.microchipID,
            sterilized: pet.sterilized,
            pocCompleted: pet.pocCompleted,
            avsLicenseId: pet.avsLicenseID,
            avsLicenseExpiry: PetDateFormat.day.string(from: pet.avsLicenseExpiry),
            photoPath: nil,
            adoptionDate: PetDateFormat.day.string(from: pet.adoptionDate)
        )
    }

    /// 从本地 Pet 构造完整 update payload（PATCH）。
    /// 当前 UI 的编辑面是「整只 pet 回写」，故这里也带全字段；后端按 partial 接受即可。
    static func update(from pet: Pet) -> PetPayload {
        create(from: pet)
    }
}

// MARK: - 日期格式

/// pet 字段用到的两种日期串格式，集中在一处避免散落硬编码。
enum PetDateFormat {
    /// 纯日期 yyyy-MM-dd（dob / avs_license_expiry / adoption_date）。
    case day
    /// ISO-8601（created_at / updated_at，timestamptz）。
    case iso

    func date(from string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        switch self {
        case .day:
            return Self.dayFormatter.date(from: String(string.prefix(10)))
        case .iso:
            // 后端可能带毫秒或不带，两个 ISO formatter 都试一遍
            return Self.isoWithFractional.date(from: string)
                ?? Self.isoPlain.date(from: string)
        }
    }

    func string(from date: Date?) -> String? {
        guard let date else { return nil }
        switch self {
        case .day: return Self.dayFormatter.string(from: date)
        case .iso: return Self.isoPlain.string(from: date)
        }
    }

    // yyyy-MM-dd，固定 UTC + POSIX locale，避免设备时区把日期挪一天
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let isoWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()
}
