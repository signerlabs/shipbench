//
//  HealthRecordService.swift
//  PetBook
//
//  健康记录（疫苗 / 驱虫 / 就诊 / 体重）4 类 CRUD 的端点封装。
//  完全照 PetService 的范式：把契约（路径 + 方法 + 请求/响应外壳）收在一处，
//  Store 只调语义化方法（list / create / update / delete），不碰 URL 与 DTO 细节。
//
//  契约（base https://api.example.com），4 类全部挂 pet 下：
//    GET    /v1/pets/{petId}/{resource}        → { {plural}:  [Row] }（后端已倒序）
//    POST   /v1/pets/{petId}/{resource}        → 201 { {singular}: Row }
//    PATCH  /v1/pets/{petId}/{resource}/{id}   → { {singular}: Row }
//    DELETE /v1/pets/{petId}/{resource}/{id}   → { deleted: id }
//
//  resource 路径段（与萧何对齐）：
//    vaccinations / dewormings / vet-visits / weights
//
//  ⚠️ 与萧何对齐点：响应外壳的 JSON key。本文件按 camelCase 单复数解（vetVisits / vetVisit）。
//     若后端实际返回 snake_case（vet_visits / vet_visit），需在对应 *Response 加 CodingKeys。
//

import Foundation

struct HealthRecordService {

    private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// pet 下资源路径前缀（id 统一小写，与 PetService 一致）。
    private func base(_ petID: UUID, _ resource: String) -> String {
        "/v1/pets/\(petID.uuidString.lowercased())/\(resource)"
    }

    // MARK: - 疫苗 Vaccination

    func listVaccinations(petID: UUID) async throws -> [VaccinationRecord] {
        let resp: VaccinationListResponse = try await client.authorizedRequest(
            base(petID, "vaccinations"), method: .get
        )
        return resp.vaccinations.map { $0.toRecord() }
    }

    func createVaccination(petID: UUID, _ record: VaccinationRecord) async throws -> VaccinationRecord {
        let resp: VaccinationResponse = try await client.authorizedRequest(
            base(petID, "vaccinations"), method: .post,
            body: VaccinationPayload.from(record)
        )
        return resp.vaccination.toRecord()
    }

    func updateVaccination(petID: UUID, _ record: VaccinationRecord) async throws -> VaccinationRecord {
        let resp: VaccinationResponse = try await client.authorizedRequest(
            base(petID, "vaccinations") + "/\(record.id.uuidString.lowercased())", method: .patch,
            body: VaccinationPayload.update(from: record)   // update：可清空字段 nil→null
        )
        return resp.vaccination.toRecord()
    }

    @discardableResult
    func deleteVaccination(petID: UUID, id: UUID) async throws -> String {
        let resp: HealthRecordDeleteResponse = try await client.authorizedRequest(
            base(petID, "vaccinations") + "/\(id.uuidString.lowercased())", method: .delete
        )
        return resp.deleted
    }

    // MARK: - 驱虫 Deworming

    func listDewormings(petID: UUID) async throws -> [DewormingRecord] {
        let resp: DewormingListResponse = try await client.authorizedRequest(
            base(petID, "dewormings"), method: .get
        )
        return resp.dewormings.map { $0.toRecord() }
    }

    func createDeworming(petID: UUID, _ record: DewormingRecord) async throws -> DewormingRecord {
        let resp: DewormingResponse = try await client.authorizedRequest(
            base(petID, "dewormings"), method: .post,
            body: DewormingPayload.from(record)
        )
        return resp.deworming.toRecord()
    }

    func updateDeworming(petID: UUID, _ record: DewormingRecord) async throws -> DewormingRecord {
        let resp: DewormingResponse = try await client.authorizedRequest(
            base(petID, "dewormings") + "/\(record.id.uuidString.lowercased())", method: .patch,
            body: DewormingPayload.update(from: record)   // update：可清空字段 nil→null
        )
        return resp.deworming.toRecord()
    }

    @discardableResult
    func deleteDeworming(petID: UUID, id: UUID) async throws -> String {
        let resp: HealthRecordDeleteResponse = try await client.authorizedRequest(
            base(petID, "dewormings") + "/\(id.uuidString.lowercased())", method: .delete
        )
        return resp.deleted
    }

    // MARK: - 就诊 VetVisit

    func listVetVisits(petID: UUID) async throws -> [VetVisitRecord] {
        let resp: VetVisitListResponse = try await client.authorizedRequest(
            base(petID, "vet-visits"), method: .get
        )
        return resp.vetVisits.map { $0.toRecord() }
    }

    func createVetVisit(petID: UUID, _ record: VetVisitRecord) async throws -> VetVisitRecord {
        let resp: VetVisitResponse = try await client.authorizedRequest(
            base(petID, "vet-visits"), method: .post,
            body: VetVisitPayload.from(record)
        )
        return resp.vetVisit.toRecord()
    }

    func updateVetVisit(petID: UUID, _ record: VetVisitRecord) async throws -> VetVisitRecord {
        let resp: VetVisitResponse = try await client.authorizedRequest(
            base(petID, "vet-visits") + "/\(record.id.uuidString.lowercased())", method: .patch,
            body: VetVisitPayload.update(from: record)   // update：可清空字段 nil→null
        )
        return resp.vetVisit.toRecord()
    }

    @discardableResult
    func deleteVetVisit(petID: UUID, id: UUID) async throws -> String {
        let resp: HealthRecordDeleteResponse = try await client.authorizedRequest(
            base(petID, "vet-visits") + "/\(id.uuidString.lowercased())", method: .delete
        )
        return resp.deleted
    }

    // MARK: - 体重 Weight

    func listWeights(petID: UUID) async throws -> [WeightRecord] {
        let resp: WeightListResponse = try await client.authorizedRequest(
            base(petID, "weights"), method: .get
        )
        return resp.weights.map { $0.toRecord() }
    }

    func createWeight(petID: UUID, _ record: WeightRecord) async throws -> WeightRecord {
        let resp: WeightResponse = try await client.authorizedRequest(
            base(petID, "weights"), method: .post,
            body: WeightPayload.from(record)
        )
        return resp.weight.toRecord()
    }

    func updateWeight(petID: UUID, _ record: WeightRecord) async throws -> WeightRecord {
        let resp: WeightResponse = try await client.authorizedRequest(
            base(petID, "weights") + "/\(record.id.uuidString.lowercased())", method: .patch,
            body: WeightPayload.from(record)
        )
        return resp.weight.toRecord()
    }

    @discardableResult
    func deleteWeight(petID: UUID, id: UUID) async throws -> String {
        let resp: HealthRecordDeleteResponse = try await client.authorizedRequest(
            base(petID, "weights") + "/\(id.uuidString.lowercased())", method: .delete
        )
        return resp.deleted
    }
}
