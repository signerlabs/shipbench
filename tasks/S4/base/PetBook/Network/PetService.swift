//
//  PetService.swift
//  PetBook
//
//  pet CRUD 的端点封装。把契约（路径 + 方法 + 请求/响应外壳）收在一处，
//  Store 只调语义化方法（list / create / update / delete），不碰 URL 与 DTO 细节。
//
//  契约（base https://api.example.com）：
//    GET    /v1/pets        → { pets: [PetRow] }
//    POST   /v1/pets        → 201 { pet: PetRow }
//    PATCH  /v1/pets/:id    → { pet: PetRow }
//    DELETE /v1/pets/:id    → { deleted: id }
//

import Foundation

struct PetService {

    private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// GET /v1/pets — 拉当前用户全部宠物（RLS 已在后端按 owner 隔离）。
    func list() async throws -> [Pet] {
        let resp: PetListResponse = try await client.authorizedRequest(
            "/v1/pets",
            method: .get
        )
        return resp.pets.map { $0.toPet() }
    }

    /// POST /v1/pets — 创建宠物，返回后端落库后的真实行（含 server 生成的 id / owner_id / created_at）。
    func create(_ pet: Pet) async throws -> Pet {
        let resp: PetResponse = try await client.authorizedRequest(
            "/v1/pets",
            method: .post,
            body: PetPayload.create(from: pet)
        )
        return resp.pet.toPet()
    }

    /// PATCH /v1/pets/:id — 更新宠物，返回更新后的行。
    func update(_ pet: Pet) async throws -> Pet {
        let resp: PetResponse = try await client.authorizedRequest(
            "/v1/pets/\(pet.id.uuidString.lowercased())",
            method: .patch,
            body: PetPayload.update(from: pet)
        )
        return resp.pet.toPet()
    }

    /// DELETE /v1/pets/:id — 删除宠物，返回被删的 id。
    @discardableResult
    func delete(id: UUID) async throws -> String {
        let resp: PetDeleteResponse = try await client.authorizedRequest(
            "/v1/pets/\(id.uuidString.lowercased())",
            method: .delete
        )
        return resp.deleted
    }
}
