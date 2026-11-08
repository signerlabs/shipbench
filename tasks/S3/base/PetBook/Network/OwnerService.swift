//
//  OwnerService.swift
//  PetBook
//
//  主人档案网络层（GET / PATCH /v1/owner），照 PetService 范式：持有 APIClient，
//  方法走 client.authorizedRequest（自动带 Bearer + 401 刷新重放）。
//

import Foundation

final class OwnerService {
    private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// GET /v1/owner —— 读当前 user 的 owner profile。
    func get() async throws -> Owner {
        let resp: OwnerResponse = try await client.authorizedRequest(
            "/v1/owner",
            method: .get
        )
        return resp.owner.toOwner()
    }

    /// PATCH /v1/owner —— 更新 owner profile（传 4 字段快照，后端整体更新；nil=清空）。
    func update(_ owner: Owner) async throws -> Owner {
        let payload = OwnerUpdatePayload(
            displayName: owner.displayName,
            postalCode: owner.postalCode,
            residenceType: owner.residenceType?.rawValue,
            primaryPhone: owner.primaryPhone,
            pocCompleted: owner.pocCompleted
        )
        let resp: OwnerResponse = try await client.authorizedRequest(
            "/v1/owner",
            method: .patch,
            body: payload
        )
        return resp.owner.toOwner()
    }
}
