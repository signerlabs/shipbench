//
//  AuthManager.swift
//  PetBook
//
//  匿名优先的鉴权管理（零依赖）。职责：
//    • bootstrap()：首启先查 Keychain —— 有 token 直接复用（不重新匿名登录，控制匿名用户堆积）；
//                   无则 POST /v1/auth/anon 拿 token 落 Keychain。
//    • 401 自动刷新：refresh() → POST /v1/auth/refresh 换新 token、更新 Keychain；
//                   刷新失败 → 退回重新匿名登录（reAnon）。
//
//  隔离：工程 SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor，网络层统一跑在 MainActor，
//  与 PetBookStore / APIClient 一致。刷新并发安全靠「复用进行中的刷新 Task」实现：
//  多个请求同时 401 时，只有第一个发起真实刷新，其余 await 同一个 Task 拿结果，
//  避免「刷新风暴」——多个请求各刷一次、互相把对方的新 token 作废。
//

import Foundation

/// 鉴权 token 响应（auth/anon 与 auth/refresh 同结构，camelCase）。
struct AuthTokenResponse: Decodable {
    let userId: String
    let accessToken: String
    let refreshToken: String
    let isAnonymous: Bool
}

/// refresh 请求体。
private struct RefreshPayload: Encodable {
    let refreshToken: String
}

/// Apple 关联请求体（/v1/auth/link）。Apple 仅首次授权返回 fullName，一并上传落库。
private struct AppleLinkPayload: Encodable {
    let appleIdToken: String
    /// SIWA 防重放 nonce 的「原始值」（前端把 SHA256(nonce) 给 Apple，raw 传后端）
    let nonce: String?
    let fullName: String?
}

/// Apple 关联响应。user id 不变；关联后 isAnonymous 为 false；email 可能为空（用户隐藏邮箱时由 Apple relay）。
struct AppleLinkResponse: Decodable {
    /// "linked" = apple 绑到当前匿名 user（首次绑定，user id 不变）；
    /// "signed_in" = 该 apple 已绑别的 user → 登录回那个 user（换机 / 重装找回），带回其 token。
    let mode: String
    let userId: String?
    let email: String?
    let isAnonymous: Bool
    /// 仅 signed_in 模式返回：已绑 user 的 token，iOS 据此切换账号。
    let accessToken: String?
    let refreshToken: String?
}

/// 删账号响应。
private struct DeleteAccountResponse: Decodable {
    let deleted: String
}

@MainActor
final class AuthManager {

    private let client: APIClient

    /// 当前 token（Keychain 是持久化真相，这里是热路径加速）。
    private var accessToken: String?
    private var refreshToken: String?

    /// 当前 userId（供上层关联本地数据所有者，非必须）。
    private(set) var userId: String?

    /// 进行中的刷新任务。非 nil 表示已有刷新在跑，后续 401 复用它而非再发一次。
    private var refreshTask: Task<String, Error>?

    /// 「已安装」标记 key（存 UserDefaults）。UserDefaults 在 app 卸载时必清，
    /// 故无此标记 = 全新安装（含删 app 重装）→ 据此清 Keychain 残留 token。
    private static let hasInstalledFlagKey = "com.example.petbook.hasInstalledFlag"

    init(client: APIClient) {
        self.client = client
    }

    // MARK: - 启动引导

    /// 首启引导：有 token 复用，无 token 匿名登录。
    /// 完成后把 tokenProvider / refreshHandler 注入 APIClient，让后续业务请求自动带 token + 401 刷新。
    func bootstrap() async throws {
        // 0) 全新安装检测：UserDefaults 在 app 卸载时必清（Keychain 却会残留），
        //    故无「已安装」标记 = 删 app 重装 / 首次安装 → 清掉 Keychain 残留 token，
        //    确保「删 app = 100% 全新匿名用户」、行为可预期（不再复用上个账号的旧 token）。
        //    注：仅"删 app"会清 UserDefaults；Xcode 覆盖 build（不删 app）仍复用同账号。
        if !UserDefaults.standard.bool(forKey: Self.hasInstalledFlagKey) {
            KeychainStore.delete(KeychainStore.Key.accessToken)
            KeychainStore.delete(KeychainStore.Key.refreshToken)
            UserDefaults.standard.set(true, forKey: Self.hasInstalledFlagKey)
        }

        // 1) 先查 Keychain —— 关键：复用已有 token，不每次启动都新建匿名用户
        if let saved = KeychainStore.read(KeychainStore.Key.accessToken),
           let savedRefresh = KeychainStore.read(KeychainStore.Key.refreshToken) {
            self.accessToken = saved
            self.refreshToken = savedRefresh
        } else {
            // 2) 无 token → 匿名登录
            try await anonLogin()
        }

        // 3) 注入闭包到 client（同为 MainActor，同步读 token / await 刷新均安全）
        client.tokenProvider = { [weak self] in
            self?.accessToken
        }
        client.refreshHandler = { [weak self] in
            guard let self else { throw APIError.unauthorized }
            return try await self.refresh()
        }
    }

    // MARK: - 匿名登录

    /// POST /v1/auth/anon → 存 token。
    private func anonLogin() async throws {
        let resp: AuthTokenResponse = try await client.publicRequest(
            "/v1/auth/anon",
            method: .post,
            body: nil
        )
        persist(resp)
    }

    // MARK: - 刷新

    /// 用 refreshToken 换新 token；失败则退回重新匿名登录。返回新的 access token。
    /// 复用进行中的刷新 Task，保证并发 401 只触发一次真实刷新。
    func refresh() async throws -> String {
        // 已有刷新在跑 → 复用
        if let task = refreshTask {
            return try await task.value
        }

        let task = Task<String, Error> { [self] in
            defer { refreshTask = nil }   // 跑完清空，下次 401 可再发起
            return try await performRefresh()
        }
        refreshTask = task
        return try await task.value
    }

    /// 真正的刷新逻辑：refresh token 被后端「明确拒绝」(401) 才退回重新匿名；
    /// 临时故障（网络 / 5xx / 解码失败）一律抛错、绝不 reAnon——避免把瞬时错误变成永久数据丢失。
    private func performRefresh() async throws -> String {
        if let currentRefresh = refreshToken {
            do {
                let resp: AuthTokenResponse = try await client.publicRequest(
                    "/v1/auth/refresh",
                    method: .post,
                    body: RefreshPayload(refreshToken: currentRefresh)
                )
                persist(resp)
                return resp.accessToken
            } catch APIError.unauthorized {
                // 仅当后端明确拒绝 refresh token（401：过期 / 被吊销）才退回重新匿名。
                // 旧匿名身份确实不可恢复，reAnon 是唯一出路（绑了 Apple 才能跨此恢复）。
                return try await reAnon()
            } catch {
                // ⚠️ 临时故障（网络中断 / 5xx / 解码失败）：原样抛出，绝不 reAnon。
                // reAnon 会把可恢复的瞬时错误变成「换新空账号、旧数据永久失联」（本次 Mochi 丢失的根因）。
                // 上层报错即可，Keychain 旧 token 原样保留，下次请求 / 重试仍可能刷新成功，账号不丢。
                throw error
            }
        } else {
            // 没有 refresh token 可用 → 直接重新匿名登录
            return try await reAnon()
        }
    }

    /// 退回重新匿名登录并返回新 access token。
    private func reAnon() async throws -> String {
        try await anonLogin()
        guard let token = accessToken else { throw APIError.unauthorized }
        return token
    }

    // MARK: - Apple 关联（F7.5：匿名 → 永久，user id 不变）

    /// 把 Apple 身份 link 到当前 user（后端 POST /v1/auth/link，需当前 access token）。
    /// 后端走 GoTrue linkIdentity（id_token 流）真正写入一条 apple identity，user id / 数据保留，
    /// 多设备 Apple 登录可识别。Apple 仅首次返回 fullName/email，一并上传。
    /// nonce：SIWA 防重放——前端把 SHA256(nonce) 给 Apple、raw nonce 传后端，GoTrue 校验匹配。
    /// 注意：关联成功后当前 access token 的 is_anonymous claim 仍是旧值（JWT 签发即固定），
    /// 下次刷新自动翻为 false；期间数据访问不受影响（user id 不变）。
    func linkApple(idToken: String, nonce: String?, fullName: String?) async throws -> AppleLinkResponse {
        let resp: AppleLinkResponse = try await client.authorizedRequest(
            "/v1/auth/link",
            method: .post,
            body: AppleLinkPayload(appleIdToken: idToken, nonce: nonce, fullName: fullName)
        )
        // signed_in：该 Apple 已绑别的 user → 切换到那个 user 的 session（换机 / 重装找回数据）。
        // 替换内存 + Keychain 的 token，后续请求即以「已绑 user」身份发出。
        if resp.mode == "signed_in", let at = resp.accessToken, let rt = resp.refreshToken {
            self.accessToken = at
            self.refreshToken = rt
            self.userId = resp.userId
            KeychainStore.save(at, for: KeychainStore.Key.accessToken)
            KeychainStore.save(rt, for: KeychainStore.Key.refreshToken)
        }
        return resp
    }

    // MARK: - 删除账号（F7.4：不可逆）

    /// 永久删除当前账号：后端 admin.deleteUser 级联清库 → 清 Keychain →
    /// 重新匿名登录（app 无需重启即继续可用，等价全新匿名用户）。
    /// 删除请求用当前 token（删的就是当前 user）；删完旧 token 失效，故立即重新匿名。
    func deleteAccount() async throws {
        // 1) 后端删（当前 user 仍在，identityMiddleware 校验通过）
        let _: DeleteAccountResponse = try await client.authorizedRequest(
            "/v1/auth/account",
            method: .delete
        )
        // 2) 清当前身份（Keychain + 内存热路径）
        KeychainStore.delete(KeychainStore.Key.accessToken)
        KeychainStore.delete(KeychainStore.Key.refreshToken)
        accessToken = nil
        refreshToken = nil
        userId = nil
        // 3) 重新匿名登录，拿全新身份并落 Keychain
        try await anonLogin()
    }

    // MARK: - 持久化

    /// 写内存 + Keychain，两处一致。
    private func persist(_ resp: AuthTokenResponse) {
        self.accessToken = resp.accessToken
        self.refreshToken = resp.refreshToken
        self.userId = resp.userId
        KeychainStore.save(resp.accessToken, for: KeychainStore.Key.accessToken)
        KeychainStore.save(resp.refreshToken, for: KeychainStore.Key.refreshToken)
    }
}
