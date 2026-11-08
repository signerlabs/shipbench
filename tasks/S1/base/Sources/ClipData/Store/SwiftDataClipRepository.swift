//
//  SwiftDataClipRepository.swift
//  ClipData
//
//  ClipRepository 的正式实现：对外是普通对象，可在主线程同步创建；内部由 StoreHost 在主线程之外打开两个库（History、Pinboard 各一个
//  ModelContainer）、建好唯一的写入 actor，之后每个调用都转给它。库打不开时按规则恢复或退避重试，经 storeEvents 告诉 App。
//  打开 iCloud 同步时另起 CloudSyncMonitor 旁听同步事件，经 cloudUpdates 把状态与"别的 Mac 改了数据"告诉 App。
//  接着 iCloud 时，刚打开那一下 Pinboard 列表是空的：读缓存在后台装好后发 .dataChanged，界面重读（不让打开流程等系统的 iCloud 镜像）。
//
//  搜索索引在后台修补 / 重建时（storeEvents 发 .searchIndexRebuilding）：搜索照常走索引——修补时旧行都在、结果完整；
//  索引文件丢了或坏了重建时从最新的条目逐批补起（每批 200 条，10 万条约半分钟），先搜得到最近的内容。其他调用不受影响。
//

import Foundation

public final class SwiftDataClipRepository: ClipRepository, Sendable {

    private let host: StoreHost
    /// iCloud 同步的状态与"别的 Mac 改了数据"；不同步时立即结束
    public let cloudUpdates: AsyncStream<CloudSyncUpdate>
    /// 数据库的可用状态：打开成功、损坏后已恢复、同步库没接上 iCloud、暂时打不开、搜索索引后台重建（见 StoreEvent）
    public let storeEvents: AsyncStream<StoreEvent>

    /// directory：数据库所在目录（App 沙盒容器里的 Application Support/ClipApp）；
    /// cloudKitContainer：Pinboard 同步用的 iCloud 容器，nil = 不同步（开关切换后重启生效）
    public convenience init(directory: URL, cloudKitContainer: String? = nil) {
        self.init(directory: directory, cloudKitContainer: cloudKitContainer, firstRetryDelay: .seconds(2), makeContainer: StoreFiles.makeContainer)
    }

    /// 测试用：可替换建 ModelContainer 的方式与重试间隔
    init(directory: URL, cloudKitContainer: String?, firstRetryDelay: Duration, makeContainer: @escaping StoreHost.ContainerFactory) {
        // 先开始旁听同步事件，再打开数据库：打开时的第一次设置与导入也要收到
        let events = cloudKitContainer.map { _ in CloudSyncMonitor.observeEvents() }
        let (storeEvents, storeContinuation) = AsyncStream.makeStream(of: StoreEvent.self, bufferingPolicy: .bufferingNewest(32))
        self.storeEvents = storeEvents
        let (updates, continuation) = AsyncStream.makeStream(of: CloudSyncUpdate.self, bufferingPolicy: .bufferingNewest(32))
        cloudUpdates = updates
        let host = StoreHost(
            directory: directory,
            cloudKitContainer: cloudKitContainer,
            events: storeContinuation,
            firstRetryDelay: firstRetryDelay,
            makeContainer: makeContainer,
            // 接着 iCloud 时 Pinboard 的读缓存在后台装好后让界面重读（不同步时这条流已结束，不会发）
            onCloudDataChanged: { continuation.yield(.dataChanged) }
        )
        self.host = host
        let monitor = cloudKitContainer.map { CloudSyncMonitor(containerIdentifier: $0, host: host, updates: continuation) }
        if let monitor, let events {
            monitor.start(events)
        } else {
            continuation.finish()
        }
        // 不等第一个调用，马上开始打开
        Task.detached(priority: .userInitiated) {
            if let monitor { await host.attach(monitor) }
            _ = try? await host.store()
        }
    }

    // MARK: - 读

    public func pinboards() async throws -> [Pinboard] {
        try await host.store().pinboards()
    }

    public func page(_ query: ClipQuery, after cursor: ClipCursor?, limit: Int) async throws -> ClipPage {
        try await host.store().page(query, after: cursor, limit: limit)
    }

    public func payload(for id: ClipItem.ID) async throws -> ClipPayload {
        try await host.store().payload(for: id)
    }

    public func thumbnail(for id: ClipItem.ID) async -> Data? {
        guard let store = try? await host.store() else { return nil }
        return (try? await store.thumbnail(for: id)) ?? nil
    }

    public func historyCount(before date: Date?) async throws -> Int {
        try await host.store().historyCount(before: date)
    }

    // MARK: - 写

    public func ingest(_ draft: ClipDraft) async throws -> ClipItem {
        try await host.store().ingest(draft)
    }

    public func markUsed(_ id: ClipItem.ID) async throws -> ClipItem {
        try await host.store().markUsed(id)
    }

    public func rename(_ id: ClipItem.ID, to title: String?) async throws -> ClipItem {
        try await host.store().rename(id, to: title)
    }

    public func pin(_ id: ClipItem.ID, to pinboardID: Pinboard.ID?) async throws -> ClipItem? {
        try await host.store().pin(id, to: pinboardID)
    }

    public func remove(_ id: ClipItem.ID, from scope: ClipRemovalScope) async throws -> ClipRemoval {
        try await host.store().remove(id, from: scope)
    }

    public func undo(_ removal: ClipRemoval) async throws -> ClipItem {
        try await host.store().undo(removal)
    }

    /// 分批删（每批一个事务），批与批之间让出写入 actor：清空十万条时采集与面板不被挡住。
    /// nil = 现有的全部；清空过程中新复制的不受影响
    public func eraseHistory(before date: Date?) async throws {
        let store = try await host.store()
        let cutoff: Date
        if let date {
            cutoff = date
        } else {
            cutoff = await store.eraseAllCutoff()
        }
        while try await store.eraseHistoryBatch(before: cutoff) > 0 {
            await Task.yield()
        }
    }

    // MARK: - Pinboard

    public func createPinboard(id: Pinboard.ID, name: String, color: PinboardColor) async throws -> Pinboard {
        try await host.store().createPinboard(id: id, name: name, color: color)
    }

    public func updatePinboard(_ pinboard: Pinboard) async throws {
        try await host.store().updatePinboard(pinboard)
    }

    public func deletePinboard(_ id: Pinboard.ID) async throws {
        try await host.store().deletePinboard(id)
    }

    public func movePinboard(_ id: Pinboard.ID, by offset: Int) async throws {
        try await host.store().movePinboard(id, by: offset)
    }

    // MARK: - 示例内容

    public func markAsExamples(clipIDs: Set<ClipItem.ID>, pinboardIDs: Set<Pinboard.ID>) async throws {
        try await host.store().markAsExamples(clipIDs: clipIDs, pinboardIDs: pinboardIDs)
    }

    public func hasUntouchedExamples() async -> Bool {
        guard let store = try? await host.store() else { return false }
        return (try? await store.hasUntouchedExamples()) ?? false
    }

    public func removeUntouchedExamples() async throws {
        try await host.store().removeUntouchedExamples()
    }

    // MARK: - 维护

    /// 物理删除软删除早于某时刻的条目（启动时传 .now 清掉上次运行留下的）。History 当场删；Pinboard 副本（另有 1 小时宽限）
    /// 与孤儿巡检排进后台、不等它做完——同步库可能正被系统的 iCloud 镜像占着，界面的调用不该等它
    public func purgeTrash(olderThan date: Date) async throws {
        let store = try await host.store()
        try await store.purgeHistoryTrash(olderThan: date)
        await store.scheduleCloudMaintenance(olderThan: date)
    }

    /// 清空全部数据（Debug）
    public func removeEverything() async throws {
        try await host.store().removeEverything()
    }

    // MARK: - 测试

    /// 当前的写入 actor（测试里直接看库与索引）
    func currentStore() async throws -> ClipStore {
        try await host.store()
    }
}
