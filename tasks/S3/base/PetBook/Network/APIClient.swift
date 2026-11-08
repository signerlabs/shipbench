//
//  APIClient.swift
//  PetBook
//
//  零依赖网络层（纯 URLSession + Codable）。负责：
//    • 拼 URL、设 Authorization / Content-Type、JSON 编解码、HTTP 状态处理
//    • 401 单独抛 APIError.unauthorized，供 AuthManager 触发刷新后重放
//
//  与 AuthManager 解耦：client 不直接持有 AuthManager，而是持有两个闭包
//    • tokenProvider  —— 取「当前 access token」
//    • refreshHandler —— 遇 401 时调用，返回刷新后的新 token（失败抛错）
//  AuthManager 在 bootstrap 时把这两个闭包注入进来，避免循环依赖。
//

import Foundation

// MARK: - 错误

enum APIError: Error, LocalizedError {
    case invalidURL
    case unauthorized                  // 401：token 过期 / 无效，上层据此刷新
    case http(status: Int, body: String?)   // 其他非 2xx
    case decoding(Error)
    case transport(Error)              // URLSession 传输层错误（断网等）

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid request URL"
        case .unauthorized: return "Session expired"
        case .http(let status, let body):
            return "Server error \(status)" + (body.map { ": \($0)" } ?? "")
        case .decoding: return "Failed to parse server response"
        case .transport(let e): return e.localizedDescription
        }
    }
}

// MARK: - HTTP 方法

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case delete = "DELETE"
}

// MARK: - APIClient

/// 单实例网络客户端。用 actor 不必要（URLSession 自身线程安全，闭包注入是一次性）；
/// 用 final class + 不可变配置即可，请求方法本身无共享可变状态。
final class APIClient {

    /// 后端 base URL（PetBook Hono on Cloudflare Workers）。
    static let baseURL = URL(string: "https://api.example.com")!

    private let session: URLSession

    /// 取当前 access token（无则 nil）。由 AuthManager 注入。
    var tokenProvider: () -> String? = { nil }

    /// 401 时刷新 token，返回新 access token；刷新失败应抛错。由 AuthManager 注入。
    var refreshHandler: () async throws -> String = {
        throw APIError.unauthorized
    }

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// 共享解码器：响应 snake_case → 这里不开全局 convertFromSnakeCase，
    /// 因为各 DTO（PetRow）已显式写 snake_case CodingKeys；auth 响应是 camelCase，统一默认解码即可。
    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    // MARK: - 带鉴权请求（自动加 Bearer + 401 刷新重放）

    /// 发起一个需要鉴权的请求，解码出 `Response`。
    /// - 遇 401：调 refreshHandler 换新 token，用新 token 重放一次；仍 401 则抛 unauthorized。
    func authorizedRequest<Response: Decodable>(
        _ path: String,
        method: HTTPMethod,
        body: Encodable? = nil
    ) async throws -> Response {
        do {
            return try await send(path, method: method, body: body, token: tokenProvider())
        } catch APIError.unauthorized {
            // 第一次 401 → 刷新后重放一次
            let newToken = try await refreshHandler()
            return try await send(path, method: method, body: body, token: newToken)
        }
    }

    /// 发起一个无鉴权请求（auth/anon、auth/refresh 用），解码出 `Response`。
    func publicRequest<Response: Decodable>(
        _ path: String,
        method: HTTPMethod,
        body: Encodable? = nil
    ) async throws -> Response {
        try await send(path, method: method, body: body, token: nil)
    }

    /// 发起一个需要鉴权的、body 为原始二进制（非 JSON）的请求，解码出 `Response`。
    /// 用于照片上传（body = JPEG 字节流，Content-Type: image/jpeg）。
    /// 与 `authorizedRequest` 同样的 401 刷新重放语义：首次 401 → 刷新 token → 用新 token 重放一次。
    func authorizedRawRequest<Response: Decodable>(
        _ path: String,
        method: HTTPMethod,
        rawBody: Data,
        contentType: String
    ) async throws -> Response {
        do {
            return try await sendRaw(path, method: method, rawBody: rawBody, contentType: contentType, token: tokenProvider())
        } catch APIError.unauthorized {
            let newToken = try await refreshHandler()
            return try await sendRaw(path, method: method, rawBody: rawBody, contentType: contentType, token: newToken)
        }
    }

    // MARK: - 底层发送

    private func send<Response: Decodable>(
        _ path: String,
        method: HTTPMethod,
        body: Encodable?,
        token: String?
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: Self.baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try Self.encoder.encode(AnyEncodable(body))
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: -1, body: nil)
        }

        switch http.statusCode {
        case 200...299:
            do {
                return try Self.decoder.decode(Response.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        case 401:
            throw APIError.unauthorized
        default:
            let bodyString = String(data: data, encoding: .utf8)
            throw APIError.http(status: http.statusCode, body: bodyString)
        }
    }

    /// 底层发送原始二进制 body 的请求（照片上传）。除 body / Content-Type 外，状态码处理与 `send` 一致。
    private func sendRaw<Response: Decodable>(
        _ path: String,
        method: HTTPMethod,
        rawBody: Data,
        contentType: String,
        token: String?
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: Self.baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = rawBody

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(status: -1, body: nil)
        }

        switch http.statusCode {
        case 200...299:
            do {
                return try Self.decoder.decode(Response.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        case 401:
            throw APIError.unauthorized
        case 404:
            // 照片相关端点：404 是「该 pet 无照片」的语义信号，上层据此返回 nil（非错误）。
            throw APIError.http(status: 404, body: nil)
        default:
            let bodyString = String(data: data, encoding: .utf8)
            throw APIError.http(status: http.statusCode, body: bodyString)
        }
    }
}

// MARK: - AnyEncodable

/// 把 `Encodable` 存量类型擦除后交给 JSONEncoder（Encodable 协议本身不能直接编码）。
private struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void
    init(_ wrapped: Encodable) {
        self.encodeFunc = { encoder in try wrapped.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeFunc(encoder)
    }
}
