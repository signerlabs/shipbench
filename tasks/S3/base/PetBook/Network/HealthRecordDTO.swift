//
//  HealthRecordDTO.swift
//  PetBook
//
//  健康记录（疫苗 / 驱虫 / 就诊 / 体重）的网络层数据传输对象（DTO）。
//  完全照 PetDTO 的范式：在「后端线格式」与「本地 model」间双向翻译。
//
//  大小写不对称（与后端 zod / Supabase 行约定一致，与 PetDTO 同口径）：
//    • 请求 body（create / update）→ camelCase（后端 zod schema 收 camelCase）
//    • 响应 row（*Row）           → snake_case（DB 物理列名）
//  因此请求与响应各用一套结构，不共享 CodingKeys。
//
//  类型映射：
//    • 后端 uuid 列是字符串 → 本地 id / petID / vetClinicID 是 UUID
//    • 纯日期列（administered_date / next_due_date / recorded_date / visit_date / follow_up_date）
//      是 yyyy-MM-dd 字符串 → 本地是 Date，用 PetDateFormat.day 翻译（与 pet 的 dob 同口径）
//  日期格式集中复用 PetDTO.swift 里的 PetDateFormat（同 module 可见）。
//
//  ⚠️ 与萧何对齐点：纯日期字段统一按 yyyy-MM-dd 收发（语义是「哪一天」，非时间戳）。
//     若后端实际收的是完整 ISO timestamp，需要把对应 PetDateFormat.day 换成 .iso。
//

import Foundation

// MARK: - 1. 疫苗 Vaccination

/// 响应行（snake_case，DB 行）。
struct VaccinationRowDTO: Decodable {
    let id: String
    let petId: String
    let vaccineType: String
    let administeredDate: String          // yyyy-MM-dd
    let nextDueDate: String?              // yyyy-MM-dd
    let brand: String?
    let batchNo: String?
    let vetClinicId: String?
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case id
        case petId = "pet_id"
        case vaccineType = "vaccine_type"
        case administeredDate = "administered_date"
        case nextDueDate = "next_due_date"
        case brand
        case batchNo = "batch_no"
        case vetClinicId = "vet_clinic_id"
        case notes
    }

    /// 翻译成本地 model。id / pet_id 无法解析为 UUID 时退化为新 UUID（极端容错，正常不会发生）。
    func toRecord() -> VaccinationRecord {
        VaccinationRecord(
            id: UUID(uuidString: id) ?? UUID(),
            petID: UUID(uuidString: petId) ?? UUID(),
            vaccineType: VaccineType(rawValue: vaccineType) ?? .other,
            administeredDate: PetDateFormat.day.date(from: administeredDate) ?? Date(),
            nextDueDate: PetDateFormat.day.date(from: nextDueDate),
            brand: brand,
            batchNo: batchNo,
            vetClinicID: vetClinicId.flatMap(UUID.init(uuidString:)),
            notes: notes
        )
    }
}

/// 请求体（camelCase）。全 Optional：create 填必填，update 只填要改的字段（后端 partial）。
struct VaccinationPayload: Encodable {
    var vaccineType: String?
    var administeredDate: String?         // yyyy-MM-dd
    var nextDueDate: String?              // yyyy-MM-dd
    var brand: String?
    var batchNo: String?
    var vetClinicId: String?
    var notes: String?
    /// update 语义标记：true 时可清空字段 nil→null（见 KeyedEncodingContainer.encodeClearable）。
    var clearsNilFields = false

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // vaccineType / administeredDate 必填恒有值，省略式编码即可
        try c.encodeIfPresent(vaccineType, forKey: .vaccineType)
        try c.encodeIfPresent(administeredDate, forKey: .administeredDate)
        // 用户可清空字段：update 时 nil→null（清空后端列），create 时 nil 省略
        try c.encodeClearable(nextDueDate, forKey: .nextDueDate, clearing: clearsNilFields)
        try c.encodeClearable(brand, forKey: .brand, clearing: clearsNilFields)
        try c.encodeClearable(batchNo, forKey: .batchNo, clearing: clearsNilFields)
        try c.encodeClearable(vetClinicId, forKey: .vetClinicId, clearing: clearsNilFields)
        try c.encodeClearable(notes, forKey: .notes, clearing: clearsNilFields)
    }

    enum CodingKeys: String, CodingKey {
        case vaccineType, administeredDate, nextDueDate
        case brand, batchNo, vetClinicId, notes
    }

    /// 从本地 record 构造 create payload（nil 字段省略）。
    static func from(_ r: VaccinationRecord) -> VaccinationPayload {
        VaccinationPayload(
            vaccineType: r.vaccineType.rawValue,
            administeredDate: PetDateFormat.day.string(from: r.administeredDate),
            nextDueDate: PetDateFormat.day.string(from: r.nextDueDate),
            brand: r.brand,
            batchNo: r.batchNo,
            vetClinicId: r.vetClinicID?.uuidString.lowercased(),
            notes: r.notes
        )
    }

    /// update payload：可清空字段（下次到期日 / 品牌 / 批号 / 诊所 / 备注）nil→null，支持编辑时清空。
    static func update(from r: VaccinationRecord) -> VaccinationPayload {
        var payload = from(r)
        payload.clearsNilFields = true
        return payload
    }
}

// MARK: - 2. 驱虫 Deworming

/// 响应行（snake_case，DB 行）。
struct DewormingRowDTO: Decodable {
    let id: String
    let petId: String
    let kind: String                      // internal / external / heartworm
    let administeredDate: String          // yyyy-MM-dd
    let nextDueDate: String?              // yyyy-MM-dd
    let productName: String?
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case id
        case petId = "pet_id"
        case kind
        case administeredDate = "administered_date"
        case nextDueDate = "next_due_date"
        case productName = "product_name"
        case notes
    }

    func toRecord() -> DewormingRecord {
        DewormingRecord(
            id: UUID(uuidString: id) ?? UUID(),
            petID: UUID(uuidString: petId) ?? UUID(),
            kind: DewormingKind(rawValue: kind) ?? .internalParasite,
            administeredDate: PetDateFormat.day.date(from: administeredDate) ?? Date(),
            nextDueDate: PetDateFormat.day.date(from: nextDueDate),
            productName: productName,
            notes: notes
        )
    }
}

/// 请求体（camelCase）。
struct DewormingPayload: Encodable {
    var kind: String?
    var administeredDate: String?         // yyyy-MM-dd
    var nextDueDate: String?              // yyyy-MM-dd
    var productName: String?
    var notes: String?
    /// update 语义标记：true 时可清空字段 nil→null（见 KeyedEncodingContainer.encodeClearable）。
    var clearsNilFields = false

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // kind / administeredDate 必填恒有值，省略式编码即可
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encodeIfPresent(administeredDate, forKey: .administeredDate)
        // 用户可清空字段：update 时 nil→null（清空后端列），create 时 nil 省略
        try c.encodeClearable(nextDueDate, forKey: .nextDueDate, clearing: clearsNilFields)
        try c.encodeClearable(productName, forKey: .productName, clearing: clearsNilFields)
        try c.encodeClearable(notes, forKey: .notes, clearing: clearsNilFields)
    }

    enum CodingKeys: String, CodingKey {
        case kind, administeredDate, nextDueDate, productName, notes
    }

    /// 从本地 record 构造 create payload（nil 字段省略）。
    static func from(_ r: DewormingRecord) -> DewormingPayload {
        DewormingPayload(
            kind: r.kind.rawValue,
            administeredDate: PetDateFormat.day.string(from: r.administeredDate),
            nextDueDate: PetDateFormat.day.string(from: r.nextDueDate),
            productName: r.productName,
            notes: r.notes
        )
    }

    /// update payload：可清空字段（下次到期日 / 产品名 / 备注）nil→null，支持编辑时清空。
    static func update(from r: DewormingRecord) -> DewormingPayload {
        var payload = from(r)
        payload.clearsNilFields = true
        return payload
    }
}

// MARK: - 3. 就诊 VetVisit

/// 响应行（snake_case，DB 行）。
struct VetVisitRowDTO: Decodable {
    let id: String
    let petId: String
    let visitDate: String                 // yyyy-MM-dd
    let vetClinicId: String?
    let customClinicName: String?
    let vetName: String?
    let diagnosis: String?
    let notes: String?
    let followUpNeeded: Bool?
    let followUpDate: String?             // yyyy-MM-dd

    enum CodingKeys: String, CodingKey {
        case id
        case petId = "pet_id"
        case visitDate = "visit_date"
        case vetClinicId = "vet_clinic_id"
        case customClinicName = "custom_clinic_name"
        case vetName = "vet_name"
        case diagnosis
        case notes
        case followUpNeeded = "follow_up_needed"
        case followUpDate = "follow_up_date"
    }

    func toRecord() -> VetVisitRecord {
        VetVisitRecord(
            id: UUID(uuidString: id) ?? UUID(),
            petID: UUID(uuidString: petId) ?? UUID(),
            visitDate: PetDateFormat.day.date(from: visitDate) ?? Date(),
            vetClinicID: vetClinicId.flatMap(UUID.init(uuidString:)),
            customClinicName: customClinicName,
            vetName: vetName,
            diagnosis: diagnosis,
            notes: notes,
            followUpNeeded: followUpNeeded ?? false,
            followUpDate: PetDateFormat.day.date(from: followUpDate)
        )
    }
}

/// 请求体（camelCase）。
struct VetVisitPayload: Encodable {
    var visitDate: String?                // yyyy-MM-dd
    var vetClinicId: String?
    var customClinicName: String?
    var vetName: String?
    var diagnosis: String?
    var notes: String?
    var followUpNeeded: Bool?
    var followUpDate: String?             // yyyy-MM-dd
    /// update 语义标记：true 时可清空字段 nil→null（见 KeyedEncodingContainer.encodeClearable）。
    var clearsNilFields = false

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // visitDate / followUpNeeded 必填恒有值，省略式编码即可
        try c.encodeIfPresent(visitDate, forKey: .visitDate)
        try c.encodeIfPresent(followUpNeeded, forKey: .followUpNeeded)
        // 用户可清空字段：update 时 nil→null（清空后端列），create 时 nil 省略
        try c.encodeClearable(vetClinicId, forKey: .vetClinicId, clearing: clearsNilFields)
        try c.encodeClearable(customClinicName, forKey: .customClinicName, clearing: clearsNilFields)
        try c.encodeClearable(vetName, forKey: .vetName, clearing: clearsNilFields)
        try c.encodeClearable(diagnosis, forKey: .diagnosis, clearing: clearsNilFields)
        try c.encodeClearable(notes, forKey: .notes, clearing: clearsNilFields)
        try c.encodeClearable(followUpDate, forKey: .followUpDate, clearing: clearsNilFields)
    }

    enum CodingKeys: String, CodingKey {
        case visitDate, vetClinicId, customClinicName, vetName
        case diagnosis, notes, followUpNeeded, followUpDate
    }

    /// 从本地 record 构造 create payload（nil 字段省略）。
    static func from(_ r: VetVisitRecord) -> VetVisitPayload {
        VetVisitPayload(
            visitDate: PetDateFormat.day.string(from: r.visitDate),
            vetClinicId: r.vetClinicID?.uuidString.lowercased(),
            customClinicName: r.customClinicName,
            vetName: r.vetName,
            diagnosis: r.diagnosis,
            notes: r.notes,
            followUpNeeded: r.followUpNeeded,
            followUpDate: PetDateFormat.day.string(from: r.followUpDate)
        )
    }

    /// update payload：可清空字段（诊所 / 自填诊所名 / 医生 / 诊断 / 备注 / 复诊日）nil→null，支持编辑时清空。
    static func update(from r: VetVisitRecord) -> VetVisitPayload {
        var payload = from(r)
        payload.clearsNilFields = true
        return payload
    }
}

// MARK: - 4. 体重 Weight

/// 响应行（snake_case，DB 行）。
struct WeightRowDTO: Decodable {
    let id: String
    let petId: String
    let recordedDate: String              // yyyy-MM-dd
    let weightKg: Double

    enum CodingKeys: String, CodingKey {
        case id
        case petId = "pet_id"
        case recordedDate = "recorded_date"
        case weightKg = "weight_kg"
    }

    func toRecord() -> WeightRecord {
        WeightRecord(
            id: UUID(uuidString: id) ?? UUID(),
            petID: UUID(uuidString: petId) ?? UUID(),
            recordedDate: PetDateFormat.day.date(from: recordedDate) ?? Date(),
            weightKg: weightKg
        )
    }
}

/// 请求体（camelCase）。
struct WeightPayload: Encodable {
    var recordedDate: String?             // yyyy-MM-dd
    var weightKg: Double?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(recordedDate, forKey: .recordedDate)
        try c.encodeIfPresent(weightKg, forKey: .weightKg)
    }

    enum CodingKeys: String, CodingKey {
        case recordedDate, weightKg
    }

    static func from(_ r: WeightRecord) -> WeightPayload {
        WeightPayload(
            recordedDate: PetDateFormat.day.string(from: r.recordedDate),
            weightKg: r.weightKg
        )
    }
}

// MARK: - 响应外壳（列表 / 单条 / 删除）

// 列表外壳：{ <plural>: [Row...] }（后端已倒序）
struct VaccinationListResponse: Decodable { let vaccinations: [VaccinationRowDTO] }
struct DewormingListResponse:   Decodable { let dewormings:   [DewormingRowDTO] }
struct VetVisitListResponse:    Decodable { let vetVisits:    [VetVisitRowDTO] }
struct WeightListResponse:      Decodable { let weights:      [WeightRowDTO] }

// 单条外壳：{ <singular>: Row }（create / update 返回）
struct VaccinationResponse: Decodable { let vaccination: VaccinationRowDTO }
struct DewormingResponse:   Decodable { let deworming:   DewormingRowDTO }
struct VetVisitResponse:    Decodable { let vetVisit:    VetVisitRowDTO }
struct WeightResponse:      Decodable { let weight:      WeightRowDTO }

/// 删除外壳：{ deleted: "<id>" }（4 类共用）。
struct HealthRecordDeleteResponse: Decodable { let deleted: String }
