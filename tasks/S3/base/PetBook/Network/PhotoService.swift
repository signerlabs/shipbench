//
//  PhotoService.swift
//  PetBook
//
//  宠物照片上传 / 取签名 URL 的端点封装（零依赖，复用 APIClient 的 token + 401 刷新机制）。
//
//  契约（base https://api.example.com）：
//    POST /v1/pets/:id/photo      Bearer + body(JPEG binary, Content-Type: image/jpeg)
//                                 → 200 { photoPath, signedUrl }   | 404
//    GET  /v1/pets/:id/photo-url  Bearer
//                                 → 200 { signedUrl }              | 404（该 pet 无照片）
//
//  后端 bucket `pet-photos` 私有，object path = {owner_id}/{pet_id}.jpg，由后端自行拼，
//  iOS 不关心物理路径——只持有后端返回的 photoPath（作为「有远程照片」的标识）与 signedUrl（用于显示）。
//

import Foundation

// MARK: - 响应外壳

/// 上传响应：{ photoPath, signedUrl }。
/// photoPath = object path（形如 {owner_id}/{pet_id}.jpg，含 "/"），落到 Pet.photoAssetName 作远程标识；
/// signedUrl = 即时可用的临时下载 URL（可直接喂 AsyncImage）。
struct PhotoUploadResponse: Decodable {
    let photoPath: String
    let signedUrl: String
}

/// 取签名 URL 响应：{ signedUrl }。
struct PhotoURLResponse: Decodable {
    let signedUrl: String
}

// MARK: - PhotoService

struct PhotoService {

    private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    /// POST /v1/pets/:id/photo — 上传一张 JPEG，后端存进私有 bucket 并写 photo_path。
    /// - Returns: (photoPath, signedUrl) —— 调用方把 photoPath 写回 Pet.photoAssetName 作远程标识。
    func upload(petId: UUID, jpegData: Data) async throws -> (photoPath: String, signedUrl: String) {
        let resp: PhotoUploadResponse = try await client.authorizedRawRequest(
            "/v1/pets/\(petId.uuidString.lowercased())/photo",
            method: .post,
            rawBody: jpegData,
            contentType: "image/jpeg"
        )
        return (resp.photoPath, resp.signedUrl)
    }

    /// GET /v1/pets/:id/photo-url — 取该 pet 当前照片的临时签名 URL。
    /// - Returns: signedUrl；该 pet 无照片（后端 404）→ nil（非错误，正常空态）。
    func photoURL(petId: UUID) async throws -> String? {
        do {
            let resp: PhotoURLResponse = try await client.authorizedRequest(
                "/v1/pets/\(petId.uuidString.lowercased())/photo-url",
                method: .get
            )
            return resp.signedUrl
        } catch APIError.http(let status, _) where status == 404 {
            // 该 pet 无照片 → 正常空态，退回头像兜底
            return nil
        }
    }

    // MARK: - Home 沉浸页背景图（与头像分离的独立资产，端点同模式，对象路径 {owner}/{pet}-bg.jpg）

    /// POST /v1/pets/:id/background — 上传一张 JPEG 做 Home 背景，后端写 background_path。
    /// - Returns: (backgroundPath, signedUrl) —— 调用方把 backgroundPath 写回 Pet.backgroundAssetName。
    func uploadBackground(petId: UUID, jpegData: Data) async throws -> (backgroundPath: String, signedUrl: String) {
        let resp: PhotoUploadResponse = try await client.authorizedRawRequest(
            "/v1/pets/\(petId.uuidString.lowercased())/background",
            method: .post,
            rawBody: jpegData,
            contentType: "image/jpeg"
        )
        return (resp.photoPath, resp.signedUrl)
    }

    /// GET /v1/pets/:id/background-url — 取背景图的临时签名 URL；无背景（404）→ nil（正常空态）。
    func backgroundURL(petId: UUID) async throws -> String? {
        do {
            let resp: PhotoURLResponse = try await client.authorizedRequest(
                "/v1/pets/\(petId.uuidString.lowercased())/background-url",
                method: .get
            )
            return resp.signedUrl
        } catch APIError.http(let status, _) where status == 404 {
            return nil
        }
    }
}
