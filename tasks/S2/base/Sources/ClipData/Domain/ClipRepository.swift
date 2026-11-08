//
//  ClipRepository.swift
//  ClipData
//
//  数据层唯一协议：App 的 ClipLibrary 只认它，视图只认 ClipLibrary。
//  实现有两个：SwiftDataClipRepository（正式，本包）与 MockClipRepository（App 里，预览与界面调试用）。
//  方法形状即查询形状——History 与搜索走 lastUsedAt 的 keyset 分页、删除是软删除可撤销。
//

import Foundation

public protocol ClipRepository: AnyObject {

    // MARK: 读

    func pinboards() async throws -> [Pinboard]
    /// 一页条目：History 与搜索按 lastUsedAt 倒序分页；Pinboard 按排序键一次给全（条目少）
    func page(_ query: ClipQuery, after cursor: ClipCursor?, limit: Int) async throws -> ClipPage
    /// 完整内容：只在粘贴、复制、拖出时读
    func payload(for id: ClipItem.ID) async throws -> ClipPayload
    /// 卡片缩略图（图片类；PNG 数据，界面自行解码缓存）
    func thumbnail(for id: ClipItem.ID) async -> Data?
    /// History 里早于某时刻的条目数（nil = 全部）：调短保存时长、清空历史前用来提示
    func historyCount(before date: Date?) async throws -> Int

    // MARK: 写

    /// 采集一条：内容哈希相同则不新增，原条目移到最前并换成最新一次的格式
    func ingest(_ draft: ClipDraft) async throws -> ClipItem
    /// 取用后移到最前
    func markUsed(_ id: ClipItem.ID) async throws -> ClipItem
    func rename(_ id: ClipItem.ID, to title: String?) async throws -> ClipItem
    /// 收进或移出 Pinboard（nil = 移出）；移出后既不在 History 也不在任何 Pinboard 的条目随之删除，返回 nil
    func pin(_ id: ClipItem.ID, to pinboardID: Pinboard.ID?) async throws -> ClipItem?
    /// 从某处删除（软删除，可撤销； B5 两边互不影响）
    func remove(_ id: ClipItem.ID, from scope: ClipRemovalScope) async throws -> ClipRemoval
    func undo(_ removal: ClipRemoval) async throws -> ClipItem
    /// 清空 History 里早于某时刻的条目（nil = 全部），Pinboard 不受影响；不可撤销，调用方先确认
    func eraseHistory(before date: Date?) async throws

    // MARK: Pinboard

    /// id：示例 Pinboard 用固定的 uuid（两台 Mac 各装一份，同步后合成一份），用户新建的用随机 uuid（见下方扩展）
    func createPinboard(id: Pinboard.ID, name: String, color: PinboardColor) async throws -> Pinboard
    func updatePinboard(_ pinboard: Pinboard) async throws
    /// 删除 Pinboard：只在其中的条目一并删除，也在 History 里的条目留在 History
    func deletePinboard(_ id: Pinboard.ID) async throws
    func movePinboard(_ id: Pinboard.ID, by offset: Int) async throws

    // MARK: 示例内容（首次打开预置， G5）

    /// 把一批条目与 Pinboard 标成示例。之后用户改名、收进 / 移出 Pinboard、取用、又复制了同样内容，条目就算用户自己的；
    /// Pinboard 被改名、改色、挪动位置也算
    func markAsExamples(clipIDs: Set<ClipItem.ID>, pinboardIDs: Set<Pinboard.ID>) async throws
    /// 还有没被动过的示例吗（决定是否显示"一键清除示例"）
    func hasUntouchedExamples() async -> Bool
    /// 一键清除没被动过的示例；示例 Pinboard 没被改过、清完又空了的一并删除（不可撤销）
    func removeUntouchedExamples() async throws
}

public extension ClipRepository {
    func createPinboard(name: String, color: PinboardColor) async throws -> Pinboard {
        try await createPinboard(id: UUID(), name: name, color: color)
    }
}

public enum ClipRepositoryError: Error {
    case notFound
    /// 数据库暂时打不开（见 StoreEvent.unavailable），会自动退避重试；reason 是系统给的描述
    case unavailable(reason: String)
}
