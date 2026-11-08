//
//  ClinicDirectoryService.swift
//  PetBook
//
//  诊所名录数据源（PRD §11 决策3：远端 API + bundle 兜底）。
//  注：命名为 ClinicDirectoryService（诊所「名录」）以避开 Models.swift 已有的
//  `struct ClinicService`（诊所可预约「服务项目」目录，属阶段二预约能力，语义不同）。
//
//  数据流（双层）：
//    1) bundle 兜底：app 内打包了一份 clinics.json（Resource/clinics.json），首启 / 断网立即可用。
//       （schemaVersion 4，与后端管线同源：含 11 个 Google 字段、无 phone；decodeIfPresent 兜 nil。）
//    2) 远端覆盖：GET <base>/v1/clinics（后端 Hono on Cloudflare Workers 的公开端点，免鉴权），
//       成功则用远端最新数据覆盖。后端 envelope 多 phone（社区众包补的电话或 null）+ source。
//  Store 启动时先同步用 bundle 填充 vetClinics（即时有点），再异步拉远端覆盖（数据更新）。
//
//  众包电话（schemaVersion 3 起）：
//    • GET 拉到的诊所若 phone 非空 = 已有人补过，直接用，不再查 Apple Maps。
//    • phone 为 null 但有 Google 电话（v4 的 intlPhone/placesPhone）→ 直接用 Google 的，
//      同样不查 Apple Maps、也不回写（后端本就有这份数据，众包列只留给人工实测号码）。
//    • 两者皆无时由 ClinicMapSheet 用 MKLocalSearch 实时反查 → 查到后调 reportPhone 回写后端，
//      让后续所有用户复用（第一个查到的人补齐，后端只在 phone IS NULL 时写、之后不覆盖）。
//    • reportPhone 是「带鉴权」端点（Bearer token），故由持有 APIClient 的 PetBookStore 转调，
//      而 GET /v1/clinics 是公开端点，仍走独立的裸 URLSession 链（不带 token）。
//
//  ETag 缓存：用 URLCache（共享缓存）+ 自管 ETag 双保险——
//    • 请求带 If-None-Match（上次拿到的 ETag）；服务端数据没变 → 返回 304 Not Modified；
//    • 304 时直接复用 URLCache 里的缓存 body（不重新下载），省流量 + 提速。
//

import Foundation

/// 诊所名录数据源（远端 + bundle 兜底）。无状态工具类型，方法均为静态。
enum ClinicDirectoryService {

    /// 诊所名录公开端点（GET /v1/clinics，免鉴权、匿名可读）。诊所是公开数据，不带任何 Authorization。
    /// base 与 APIClient 一致（同一后端：Hono on Cloudflare Workers）。
    static let remoteURL = APIClient.baseURL.appendingPathComponent("v1/clinics")

    /// bundle 内打包的兜底文件名（Resource/clinics.json，随 app 一起发布）。
    private static let bundledFileName = "clinics"

    /// 上次成功拉取时服务端返回的 ETag（内存级；进程内复用做条件请求，省重复下载）。
    /// 进程重启会丢——但 URLCache 是磁盘级，重启后仍能命中缓存，二者互补。
    private nonisolated(unsafe) static var lastETag: String?

    // MARK: - 进程内电话去重缓存（合规：不持久化，app 重启即清）

    /// 本进程内已用 MKLocalSearch 查到的诊所电话（rawClinicId → phone）。
    /// 同一 app 会话内同一诊所不重复查 Apple Maps；app 重启清空（不落盘，不持久化 Apple 数据）。
    private nonisolated(unsafe) static var resolvedPhones: [String: String] = [:]

    /// 本进程内已尝试过 MKLocalSearch 反查的诊所 id 集合（含查到 / 查不到）。
    /// 查不到的也记下，避免对同一诊所反复发起注定无果的查询。
    private nonisolated(unsafe) static var triedClinicIds: Set<String> = []

    /// 读进程缓存里某诊所已查到的电话（无则 nil）。
    static func cachedResolvedPhone(forRawId rawId: String) -> String? {
        resolvedPhones[rawId]
    }

    /// 本会话内是否已对该诊所尝试过 MKLocalSearch 反查（避免重复查 Apple Maps）。
    static func hasTriedResolving(rawId: String) -> Bool {
        triedClinicIds.contains(rawId)
    }

    /// 标记某诊所已尝试反查，并把查到的电话（可能 nil）写进进程缓存。
    static func cacheResolved(rawId: String, phone: String?) {
        triedClinicIds.insert(rawId)
        if let phone { resolvedPhones[rawId] = phone }
    }

    // MARK: - 带版本号的 envelope（对齐后端生成的 JSON 结构）

    /// 真实数据是 `{ schemaVersion, generatedAt, count, note, clinics: [...] }`。
    /// 只取 clinics；其余元信息当前不用（schemaVersion 预留：未来字段不兼容时可据此降级）。
    struct Envelope: Decodable {
        let schemaVersion: Int
        let clinics: [VetClinic]
    }

    // MARK: - bundle 兜底（同步，零网络）

    /// 从 app bundle 读打包的 clinics.json 解码出诊所列表。
    /// 首启 / 断网 / 远端故障时的兜底；解析失败返回 []（绝不崩溃，地图退回空态）。
    static func loadBundled() -> [VetClinic] {
        guard let url = Bundle.main.url(forResource: bundledFileName, withExtension: "json") else {
            return []
        }
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(Envelope.self, from: data).clinics
        } catch {
            // bundle 文件理应永远可解析；真坏了也只退空态，不阻断 app。
            return []
        }
    }

    // MARK: - 远端拉取（异步，GET /v1/clinics，公开免鉴权，带 ETag 条件请求）

    /// 拉远端最新诊所列表（GET /v1/clinics，不带 Authorization）。
    /// 后端 envelope 的 phone（社区众包电话或 null）会经 VetClinic.init(from:) 自动落进 clinic.phone。
    /// - 命中 ETag（304 Not Modified）：复用 URLCache 缓存 body 解码，返回最新（与上次一致）。
    /// - 拉取 / 解码失败：抛错由调用方决定降级（Store 选择保持 bundle 数据不覆盖）。
    static func fetchRemote() async throws -> [VetClinic] {
        var request = URLRequest(url: remoteURL)
        request.httpMethod = "GET"
        // 条件请求：带上次 ETag，服务端未变更则回 304（省下载）。
        if let lastETag {
            request.setValue(lastETag, forHTTPHeaderField: "If-None-Match")
        }
        // 强制每次向服务端 revalidate（带 ETag）：数据没变 → 304 复用缓存省流量；变了 → 200 拿最新。
        // 用 reloadRevalidatingCacheData 而非 useProtocolCachePolicy——杜绝 URLCache 返回陈旧缓存
        //（曾因缓存旧版 v1 远端响应、反把 bundle 的最新 v2 覆盖掉，导致新字段不显示）。
        request.cachePolicy = .reloadRevalidatingCacheData

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        // 记录最新 ETag（供下次条件请求）。
        if let etag = http.value(forHTTPHeaderField: "ETag") {
            lastETag = etag
        }

        switch http.statusCode {
        case 200...299:
            return try JSONDecoder().decode(Envelope.self, from: data).clinics
        case 304:
            // 未变更：URLSession 对 304 通常已自动回填 URLCache 的 body 到 data；
            // 若 data 为空则从 URLCache 显式取一次缓存响应解码（双保险）。
            if !data.isEmpty {
                return try JSONDecoder().decode(Envelope.self, from: data).clinics
            }
            if let cached = URLCache.shared.cachedResponse(for: request) {
                return try JSONDecoder().decode(Envelope.self, from: cached.data).clinics
            }
            // 既无 body 又无缓存（极端）：抛错让调用方保持现有数据不动。
            throw URLError(.resourceUnavailable)
        default:
            throw URLError(.init(rawValue: http.statusCode))
        }
    }

    // MARK: - 众包电话回写（带鉴权 POST /v1/clinics/:id/phone）

    /// 回写体：只一个号码字段。
    private struct PhonePayload: Encodable {
        let phone: String
    }

    /// 回写响应：后端只在该诊所 phone IS NULL 时写（第一个查到的用户补齐，之后不覆盖）。
    private struct PhoneReportResponse: Decodable {
        let updated: Bool
        let phone: String?
        let reason: String?
    }

    /// 把 MKLocalSearch 查到的电话回写后端，让其他用户复用（众包补齐）。
    /// - 带鉴权：走传入的 APIClient（自动加 Bearer + 401 刷新重放），token 从 AuthManager 注入的 tokenProvider 取。
    /// - rawClinicId：后端原始 string id（VetClinic.rawId），不是派生 UUID。
    /// - 失败静默：回写是「锦上添花」的众包行为，失败绝不抛给 UI（本地 MKLocalSearch 已查到、Call 照常可用）。
    static func reportPhone(client: APIClient, rawClinicId: String, phone: String) async {
        // rawClinicId 兜底为空（理论不会，rawId 至少是 UUID 字符串）时直接跳过，不发无效请求。
        guard !rawClinicId.isEmpty else { return }
        do {
            let _: PhoneReportResponse = try await client.authorizedRequest(
                "/v1/clinics/\(rawClinicId)/phone",
                method: .post,
                body: PhonePayload(phone: phone)
            )
        } catch {
            // 静默：网络失败 / 后端拒绝 / 已有人补过（updated=false）都无所谓，不打扰用户。
        }
    }
}
