//
//  OwnerDTO.swift
//  PetBook
//
//  主人档案 DTO —— owner profile 在「后端线格式」与本地 Owner model 间双向翻译。
//  响应 OwnerRow 用 snake_case（DB 行）；请求 OwnerUpdatePayload 用 camelCase（对齐后端 zod）。
//

import Foundation

// MARK: - 响应：OwnerRow（snake_case，DB 行）

struct OwnerRow: Decodable {
    let id: String
    let displayName: String
    let email: String?
    let postalCode: String?
    let residenceType: String?
    let primaryPhone: String?
    let emergencyContact: String?
    let language: String?
    let hasLinkedAppleId: Bool?
    let pocCompleted: Bool?

    enum CodingKeys: String, CodingKey {
        case id, email, language
        case displayName = "display_name"
        case postalCode = "postal_code"
        case residenceType = "residence_type"
        case primaryPhone = "primary_phone"
        case emergencyContact = "emergency_contact"
        case hasLinkedAppleId = "has_linked_apple_id"
        case pocCompleted = "poc_completed"
    }

    /// 后端行 → 本地 Owner model。
    func toOwner() -> Owner {
        Owner(
            id: UUID(uuidString: id) ?? UUID(),
            displayName: displayName,
            email: email,
            postalCode: postalCode,
            residenceType: residenceType.flatMap(ResidenceType.init(rawValue:)),
            primaryPhone: primaryPhone,
            emergencyContact: emergencyContact,
            language: language.flatMap(AppLanguage.init(rawValue:)) ?? .en,
            hasLinkedAppleID: hasLinkedAppleId ?? false,
            pocCompleted: pocCompleted ?? false
        )
    }
}

/// 单条响应外壳：{ "owner": OwnerRow }
struct OwnerResponse: Decodable {
    let owner: OwnerRow
}

// MARK: - 请求：PATCH /v1/owner（camelCase）

/// owner profile 更新体：传可编辑字段的快照（后端整体更新）。
/// 显式 encode（非 encodeIfPresent）—— nil 也编码成 null，让后端能清空字段。
/// pocCompleted 非可选（一次性资质，只有 true/false 两态），随此通道一并 PATCH 回写。
struct OwnerUpdatePayload: Encodable {
    let displayName: String
    let postalCode: String?
    let residenceType: String?
    let primaryPhone: String?
    let pocCompleted: Bool

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(displayName, forKey: .displayName)
        try c.encode(postalCode, forKey: .postalCode)
        try c.encode(residenceType, forKey: .residenceType)
        try c.encode(primaryPhone, forKey: .primaryPhone)
        try c.encode(pocCompleted, forKey: .pocCompleted)
    }

    enum CodingKeys: String, CodingKey {
        case displayName, postalCode, residenceType, primaryPhone, pocCompleted
    }
}
