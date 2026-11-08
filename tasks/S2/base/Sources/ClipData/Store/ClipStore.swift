//
//  ClipStore.swift
//  ClipData
//
//  唯一的写入 actor：全部读写都串行经过这里，context 关闭 autosave、每次显式保存（失败即回滚）；
//  必须在主线程之外创建（见 StoreHost），否则会以主线程为隔离。对外只给值类型快照，不给 @Model 对象。
//  History 在本机库（Local），Pinboard 与收进来的副本在同步库（Cloud）；两个库各是一个 ModelContainer、各有自己的 coordinator，
//  这里各用一个 context（本机库用 ModelActor 自带的 modelContext，同步库用 cloud）。同一 uuid 两边合成一张卡：
//  改标题两边联动；在 History 删除不影响 Pinboard，反之亦然；搜索结果里同一内容只出现一次。
//  同步库接着 iCloud 时，系统的镜像随时占着它：读路径（列表、搜索、复制）只查同步库的读缓存（cache），
//  合并、维护这些要读写同步库的后台活放在 CloudWorker 上做，这里不排在它们后面（界面的调用不被它们拖住）。
//  执行器与优先级（后台活也一律 userInitiated）见 QueueModelExecutor。
//  只有用户改 Pinboard（收进、移出、改名、删除…）和取用只在 Pinboard 里的条目时才直接读写同步库。
//  删除走软删除（trashedAt），之后分批物理删除，先删子表再删主表。
//  同步库里同一 uuid 可能有多条（别的 Mac 同步来、合并之前）：用户的改名、移动、删除、撤销对每一条都生效。
//  搜索索引是派生数据：写失败不影响保存，记下"待修补"，由后台分批修补（startBackgroundWork），不阻塞其他调用。
//

import Darwin
import Foundation
import os
import SwiftData

actor ClipStore: ModelActor {
    /// 执行器：自己的串行队列（见 QueueModelExecutor）
    nonisolated let executor: QueueModelExecutor
    nonisolated var modelExecutor: any ModelExecutor { executor }
    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }
    /// 本机库（History）的容器：ModelActor 自带的 modelContext 就是它的
    nonisolated let modelContainer: ModelContainer
    /// 同步库（Pinboard）的容器：iCloud 镜像挂在它上面
    nonisolated let cloudContainer: ModelContainer
    /// 同步库接着 iCloud（读它可能要等系统的镜像：读缓存在后台装）
    nonisolated let isCloudMirrored: Bool
    /// 发给界面的事件（这里只发搜索索引后台修补的开始 / 结束）
    nonisolated let onEvent: @Sendable (StoreEvent) -> Void
    /// 同步库的数据在后台装好或变了、界面该重读（接着 iCloud 时由 StoreHost 接到 cloudUpdates 的 .dataChanged）
    nonisolated let onCloudDataChanged: @Sendable () -> Void

    /// 同步库的 context（写 Pinboard、取用只在 Pinboard 里的条目时用；读路径走 cache）
    let cloud: ModelContext
    /// 同步库的后台活（合并去重、快照、物理删除与孤儿巡检）
    let worker: CloudWorker
    /// 搜索旁路索引（测试里直接看它）
    let index: SearchIndex
    /// 最近一次发出的时间戳：保证 lastUsedAt 严格递增、不重复（keyset 翻页与搜索排序都靠它）
    private var lastTimestamp = Date.distantPast
    /// 上次核对同步改动时的 Pinboard 列表（判断别的 Mac 有没有改 Pinboard）
    private var mergedPinboards: [Pinboard] = []
    /// 后台修补搜索索引的进度（nil = 没在修补）
    private var repair: IndexRepair?
    /// 同步库的读缓存
    private var cache = CloudCache()
    /// 本机写同步库的流水：后台快照正在取的时候本机又写了，装缓存时这些以同步库为准重读
    private var cloudGeneration = 0
    private var cloudWrites: [CloudWrite] = []
    /// 正在取快照、还没装进缓存的后台合并数（期间本机写同步库要记流水）
    private var syncsInFlight = 0
    /// 同步库的后台活排成一列，一次一个
    private var cloudWork: Task<Bool, Never>?

    /// 检索文本上限（每次列表查询都会读到这一列，）
    private static let searchTextLimit = 16 * 1024
    /// 后台批处理（清空历史、修补索引、物理删除）每批的条数：一批约几十毫秒，期间排队的面板调用最多等这么久
    static let batchSize = 200
    /// 软删除的 Pinboard 副本至少留这么久才物理删除：它可能是别的 Mac 刚删、对方的 ⌘Z 还要用它（启动时也不例外）
    static let pinnedTrashGrace: TimeInterval = 3600

    static let log = Logger(subsystem: "com.example.clipapp", category: "data")

    /// 同步库的读缓存：列表、搜索、复制这些高频路径只查它，不碰同步库。本机写同步库后按 uuid 从库里重读；
    /// 别的 Mac 的改动由 syncFromCloud 整体换新（与界面收到 .dataChanged 再重读同一时机，看到的不会比以前旧）
    private struct CloudCache {
        var copiesLoaded = false
        var pinboardsLoaded = false
        var pinboards: [Pinboard] = []
        /// 没删的副本：同 uuid 只留按合并规则排在最前的一份
        var copies: [UUID: PinnedValue] = [:]
        /// 内容哈希 → 副本 uuid（复制同样内容时沿用它的 uuid，两边合成一张卡）
        var idByHash: [String: UUID] = [:]
    }

    private struct CloudWrite {
        let generation: Int
        let ids: Set<UUID>
        let pinboards: Bool
    }

    init(
        localContainer: ModelContainer,
        cloudContainer: ModelContainer,
        isCloudMirrored: Bool,
        index: SearchIndex,
        onEvent: @escaping @Sendable (StoreEvent) -> Void = { _ in },
        onCloudDataChanged: @escaping @Sendable () -> Void = {}
    ) {
        let context = ModelContext(localContainer)
        context.autosaveEnabled = false
        executor = QueueModelExecutor(modelContext: context, label: "com.example.clipapp.store")
        modelContainer = localContainer
        self.cloudContainer = cloudContainer
        let cloudContext = ModelContext(cloudContainer)
        cloudContext.autosaveEnabled = false
        cloud = cloudContext
        worker = CloudWorker(container: cloudContainer)
        self.isCloudMirrored = isCloudMirrored
        self.index = index
        self.onEvent = onEvent
        self.onCloudDataChanged = onCloudDataChanged
    }

    /// 打开（或新建）两个库，不做任何恢复（恢复见 StoreHost）。须在主线程之外调用。
    /// cloudKitContainer：Pinboard 同步用的 iCloud 容器，nil = 不同步
    static func make(directory: URL, cloudKitContainer: String? = nil, onEvent: @escaping @Sendable (StoreEvent) -> Void = { _ in }) throws -> ClipStore {
        let local = try StoreFiles.makeContainer(directory: directory, cloudKitContainer: nil, for: .local)
        let cloud = try StoreFiles.makeContainer(directory: directory, cloudKitContainer: cloudKitContainer, for: .cloud)
        let index = try SearchIndex.open(url: directory.appending(path: StoreFiles.searchIndexName))
        return ClipStore(localContainer: local, cloudContainer: cloud, isCloudMirrored: cloudKitContainer != nil, index: index, onEvent: onEvent)
    }

    /// 本机库的 context（ModelActor 自带的那个）
    private var local: ModelContext { modelContext }

    /// 打开后的准备：接上已有数据的时间戳。同步库没接 iCloud 时顺手装好读缓存（没有系统镜像跟它抢，直接读不会被拖住）；
    /// 接着 iCloud 时缓存留给后台（startBackgroundWork）装，打开流程不碰同步库
    func prepare() throws {
        let newestHistory = try fetchFirst(FetchDescriptor<HistoryClip>(sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)]), in: local)
        lastTimestamp = newestHistory?.lastUsedAt ?? .distantPast
        if !isCloudMirrored {
            try loadCacheDirectly()
        }
    }

    /// 打开后的后台工作（StoreHost 在打开后调用一次，不等它）：合并一遍同步改动、装好读缓存（接着 iCloud 时装好后让界面重读）；
    /// 再核对搜索索引与数据，对不上就在后台分批修补
    func startBackgroundWork() async {
        let changed = await syncFromCloud()
        // 后台合并失败的退路：直接读同步库装缓存（界面不等它）
        if !cache.copiesLoaded || !cache.pinboardsLoaded {
            do {
                try loadCacheDirectly()
            } catch {
                Self.log.error("装同步库读缓存失败：\(String(describing: error), privacy: .public)")
            }
        }
        if isCloudMirrored || changed { onCloudDataChanged() }
        do {
            if try indexNeedsRepair() { scheduleIndexRepair() }
        } catch {
            Self.log.error("核对搜索索引失败，安排修补：\(String(describing: error), privacy: .public)")
            scheduleIndexRepair()
        }
    }

    // MARK: - 读

    /// Pinboard 列表（读缓存；接着 iCloud、刚打开还没装好时是空的，装好后界面会收到 .dataChanged 重读）
    func pinboards() throws -> [Pinboard] {
        cache.pinboards
    }

    func page(_ query: ClipQuery, after cursor: ClipCursor?, limit: Int) throws -> ClipPage {
        if query.isSearching {
            return try searchPage(query.trimmedSearchText, after: cursor, limit: limit)
        }
        switch query.scope {
        case .history:
            return try historyPage(after: cursor, limit: limit)
        case .pinboard(let pinboardID):
            return try pinboardPage(pinboardID)
        }
    }

    /// 完整内容：History 里有就只读本机库；只在 Pinboard 里的条目才读同步库
    func payload(for id: UUID) throws -> ClipPayload {
        let archive = try historyClip(id)?.payload?.archive ?? pinnedClip(id)?.payload?.archive
        guard let archive else { throw ClipRepositoryError.notFound }
        return try PropertyListDecoder().decode(ClipPayload.self, from: archive)
    }

    func thumbnail(for id: UUID) throws -> Data? {
        try historyClip(id)?.thumbnail?.data ?? pinnedClip(id)?.thumbnail?.data
    }

    func historyCount(before date: Date?) throws -> Int {
        if let date {
            return try local.fetchCount(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.trashedAt == nil && $0.lastUsedAt < date }))
        }
        return try local.fetchCount(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.trashedAt == nil }))
    }

    // MARK: - 写

    func ingest(_ draft: ClipDraft) throws -> ClipItem {
        let now = nextTimestamp()
        let clip: HistoryClip
        if let existing = try historyClip(hash: draft.contentHash) {
            // C3：同一内容不新增，原条目移到最前，换成最新一次复制的格式
            clip = existing
            clip.trashedAt = nil
        } else {
            clip = HistoryClip()
            // 已收进 Pinboard 的同一内容：沿用它的 uuid，两边合成一张卡（查读缓存，不碰同步库）
            clip.uuid = draft.contentHash.isEmpty ? UUID() : cache.idByHash[draft.contentHash] ?? UUID()
            clip.createdAt = now
            local.insert(clip)
        }
        clip.lastUsedAt = now
        Self.fill(clip, from: draft)
        try replaceContent(of: clip, payload: draft.payload, thumbnail: draft.thumbnail)
        touch(clip)
        // Pinboard 副本不跟着改"最近使用"（不为每次复制写同步库）；只有没动过的示例副本被重新复制时才去改同步库（算动过）
        let touchesCloud = cache.copies[clip.uuid]?.isExample == true
        if touchesCloud { touch(try visiblePinnedClips(clip.uuid)) }
        try commit()
        if touchesCloud { noteCloudWrite(ids: [clip.uuid]) }
        reindex([clip.uuid])
        return try snapshot(history: clip, pinned: cache.copies[clip.uuid])
    }

    func markUsed(_ id: UUID) throws -> ClipItem {
        let now = nextTimestamp()
        var changedIDs: Set<UUID> = [id]
        var copies: [PinnedClip]?
        let clip: HistoryClip
        if let existing = try historyClip(id) {
            clip = existing
            clip.trashedAt = nil
        } else {
            // 只在 Pinboard 里的条目：取用后也回到 History 最前（要读同步库里的副本：内容与缩略图）。
            // History 里已有同一内容（uuid 还没对上）就改用副本的 uuid 合成一张卡，不另建第二张
            let visibleCopies = try visiblePinnedClips(id).sorted(by: CloudMerge.pinnedPrecedes)
            guard let pinned = visibleCopies.first else { throw ClipRepositoryError.notFound }
            copies = visibleCopies
            if !pinned.contentHash.isEmpty, let sameContent = try historyClip(hash: pinned.contentHash) {
                changedIDs.insert(sameContent.uuid)
                sameContent.uuid = id
                sameContent.title = pinned.title
                sameContent.trashedAt = nil
                clip = sameContent
            } else {
                clip = try historyCopy(of: pinned)
            }
        }
        clip.lastUsedAt = now
        touch(clip)
        if cache.copies[id]?.isExample == true || copies?.contains(where: \.isExample) == true {
            touch(try copies ?? visiblePinnedClips(id))
        }
        try commit()
        // 读过同步库的（缓存里可能还没有它：导入之后、合并之前）以库为准补进缓存
        if copies != nil || cache.copies[id]?.isExample == true { noteCloudWrite(ids: [id]) }
        reindex(changedIDs)
        return try snapshot(history: clip, pinned: cache.copies[id])
    }

    func rename(_ id: UUID, to title: String?) throws -> ClipItem {
        let clip = try historyClip(id)
        // 改标题两边联动；同 uuid 的每一份副本都改，免得合并时比出不同、把改名冲回去。读缓存装好了、又确定没收进 Pinboard 的不碰同步库
        let copies = try cache.copiesLoaded && cache.copies[id] == nil && clip != nil ? [] : pinnedClips(id)
        guard clip != nil || !copies.isEmpty else { throw ClipRepositoryError.notFound }
        clip?.title = title
        for copy in copies { copy.title = title }
        touch(clip)
        touch(copies)
        try commit()
        if !copies.isEmpty { noteCloudWrite(ids: [id]) }
        reindex([id])
        return try snapshot(history: clip, pinned: cache.copies[id])
    }

    func pin(_ id: UUID, to pinboardID: UUID?) throws -> ClipItem? {
        let clip = try historyClip(id)
        let copies = try pinnedClips(id)
        if let pinboardID {
            guard try !pinboardRecords(pinboardID).isEmpty else { throw ClipRepositoryError.notFound }
            let visibleCopies = copies.filter { $0.trashedAt == nil }
            if !visibleCopies.isEmpty {
                // 一条只属于一个 Pinboard：放进另一个即移动（同 uuid 的每一份一起挪）；新收进的排最前
                if visibleCopies.contains(where: { $0.pinboardID != pinboardID }) {
                    let key = try firstSortKey(in: pinboardID) - 1
                    for copy in visibleCopies {
                        copy.pinboardID = pinboardID
                        copy.pinSortKey = key
                    }
                }
                touch(visibleCopies)
            } else if let latest = copies.compactMap(\.trashedAt).max() {
                // 只剩软删除的（撤销期内）：恢复最近删掉的那批，放进这个 Pinboard
                let key = try firstSortKey(in: pinboardID) - 1
                let restored = copies.filter { $0.trashedAt == latest }
                for copy in restored {
                    copy.trashedAt = nil
                    copy.pinboardID = pinboardID
                    copy.pinSortKey = key
                }
                touch(restored)
            } else {
                // 收进 Pinboard = 复制一份进同步库
                guard let source = visible(clip) else { throw ClipRepositoryError.notFound }
                let key = try firstSortKey(in: pinboardID) - 1
                let copy = try pinnedCopy(of: source)
                copy.pinboardID = pinboardID
                copy.pinSortKey = key
                touch([copy])
            }
        } else {
            // 移出 Pinboard：副本（同 uuid 的每一份）直接删掉；不在 History 里的条目随之整条消失
            copies.forEach { CloudMerge.deletePinned($0, in: cloud) }
        }
        touch(clip)
        try commit()
        noteCloudWrite(ids: [id])
        reindex([id])
        return try? snapshot(history: clip, pinned: cache.copies[id])
    }

    func remove(_ id: UUID, from scope: ClipRemovalScope) throws -> ClipRemoval {
        let clip = try historyClip(id)
        // 只从 History 删时不碰同步库
        let visibleCopies = try scope == .history ? [] : visiblePinnedClips(id)
        let shown = cache.copies[id] ?? visibleCopies.sorted(by: CloudMerge.pinnedPrecedes).first.map(PinnedValue.init)
        let before = try snapshot(history: clip, pinned: shown)
        let now = Date.now
        if scope != .pinboard { clip?.trashedAt = now }
        // 同 uuid 的每一份一起删（只删一份的话，另一份重读时又出现，像是"删了还在"）
        for copy in visibleCopies { copy.trashedAt = now }
        try commit()
        if !visibleCopies.isEmpty { noteCloudWrite(ids: [id]) }
        reindex([id])
        return ClipRemoval(item: before, scope: scope)
    }

    func undo(_ removal: ClipRemoval) throws -> ClipItem {
        let id = removal.item.id
        let clip = try historyClip(id)
        if removal.scope != .pinboard, removal.item.isInHistory {
            clip?.trashedAt = nil
        }
        var cloudChanged = false
        if removal.scope != .history, let pinboardID = removal.item.pinboardID, try !pinboardRecords(pinboardID).isEmpty {
            let copies = try pinnedClips(id)
            if let latest = copies.compactMap(\.trashedAt).max() {
                // 恢复这次删掉的那批（同一时刻删掉的同 uuid 各份）
                for copy in copies where copy.trashedAt == latest { copy.trashedAt = nil }
                cloudChanged = true
            }
        }
        try commit()
        if cloudChanged { noteCloudWrite(ids: [id]) }
        // 原 Pinboard 已被删除时退回 History，不让条目凭空消失
        if visible(clip) == nil, cache.copies[id] == nil, let clip {
            clip.trashedAt = nil
            try commit()
        }
        reindex([id])
        return try snapshot(history: clip, pinned: cache.copies[id])
    }

    /// 清空 History 里早于某时刻的条目（nil = 现有的全部），Pinboard 不受影响。分批删、每批一个事务；
    /// 仓库会改用 eraseHistoryBatch 逐批调用，批与批之间让出 actor（采集、面板不被长时间挡住）
    func eraseHistory(before date: Date?) throws {
        let cutoff = date ?? eraseAllCutoff()
        while try eraseHistoryBatch(before: cutoff) > 0 {}
    }

    /// "清空全部"的截止时刻：已有的全部条目都早于它，清空过程中新复制的不受影响
    func eraseAllCutoff() -> Date {
        lastTimestamp.addingTimeInterval(0.0005)
    }

    /// 删掉一批早于 cutoff 的 History（含软删除的），返回删了几条；0 = 删完了。只碰本机库（还在 Pinboard 里的看读缓存）
    func eraseHistoryBatch(before cutoff: Date, limit: Int = batchSize) throws -> Int {
        var descriptor = FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.lastUsedAt < cutoff })
        descriptor.fetchLimit = limit
        // 子表一并取回，删除时不再逐条触发查询
        descriptor.relationshipKeyPathsForPrefetching = [\.payload, \.thumbnail]
        let clips = try local.fetch(descriptor)
        guard !clips.isEmpty else { return 0 }
        let ids = clips.map(\.uuid)
        clips.forEach(deleteHistory)
        try commit()
        // 一个事务写完索引（还在 Pinboard 里的按副本重写）
        reindex(ids)
        return clips.count
    }

    // MARK: - Pinboard

    func createPinboard(id: UUID, name: String, color: PinboardColor) throws -> Pinboard {
        let last = try fetchFirst(FetchDescriptor<PinboardRecord>(sortBy: [SortDescriptor(\.sortKey, order: .reverse)]), in: cloud)
        let record = PinboardRecord()
        record.uuid = id
        record.name = name
        record.colorRaw = color.rawValue
        record.sortKey = (last?.sortKey ?? -1) + 1
        cloud.insert(record)
        try commit()
        noteCloudWrite(ids: [], pinboards: true)
        return CloudMerge.pinboard(record)
    }

    func updatePinboard(_ pinboard: Pinboard) throws {
        let records = try pinboardRecords(pinboard.id)
        guard !records.isEmpty else { throw ClipRepositoryError.notFound }
        for record in records {
            record.name = pinboard.name
            record.colorRaw = pinboard.color.rawValue
            record.isExample = false
        }
        try commit()
        noteCloudWrite(ids: [], pinboards: true)
    }

    func deletePinboard(_ id: UUID) throws {
        let records = try pinboardRecords(id)
        guard !records.isEmpty else { throw ClipRepositoryError.notFound }
        let members = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.pinboardID == id }))
        let ids = Set(members.map(\.uuid))
        // B5：只在这个 Pinboard 里的条目一并删除；也在 History 里的留在 History。同 uuid 的 Pinboard 记录一并删
        members.forEach { CloudMerge.deletePinned($0, in: cloud) }
        records.forEach { cloud.delete($0) }
        try commit()
        noteCloudWrite(ids: ids, pinboards: true)
        reindex(ids)
    }

    /// 挪动位置：分数索引，只改被挪的那一个；相邻两个排序键相同（两台 Mac 各建的）或已挤到没缝，就按新顺序整体重排
    func movePinboard(_ id: UUID, by offset: Int) throws {
        let records = try cloud.fetch(FetchDescriptor<PinboardRecord>())
        let recordsByID = Dictionary(grouping: records, by: \.uuid)
        var ordered = CloudMerge.dedupedOrder(records).map(\.uuid)
        guard let index = ordered.firstIndex(of: id) else { throw ClipRepositoryError.notFound }
        let target = min(max(index + offset, 0), ordered.count - 1)
        guard target != index else { return }
        ordered.remove(at: index)
        ordered.insert(id, at: target)
        // 界面上显示的是同 uuid 里排在最前的那份
        let key: (UUID) -> Double = { recordsByID[$0]?.map(\.sortKey).min() ?? 0 }
        let previous = target > 0 ? key(ordered[target - 1]) : nil
        let next = target < ordered.count - 1 ? key(ordered[target + 1]) : nil
        var newKey: Double?
        switch (previous, next) {
        case let (previous?, next?): newKey = (previous + next) / 2
        case let (previous?, nil): newKey = previous + 1
        case let (nil, next?): newKey = next - 1
        case (nil, nil): newKey = nil
        }
        if let newKey {
            for record in recordsByID[id] ?? [] { record.sortKey = newKey }
        }
        for record in recordsByID[id] ?? [] { record.isExample = false }
        try commit()
        noteCloudWrite(ids: [], pinboards: true)
    }

    // MARK: - 示例内容

    func markAsExamples(clipIDs: Set<UUID>, pinboardIDs: Set<UUID>) throws {
        var pinnedIDs = Set<UUID>()
        for id in clipIDs {
            try historyClip(id)?.isExample = true
            // 读缓存装好了就只碰收进了 Pinboard 的那几条
            guard !cache.copiesLoaded || cache.copies[id] != nil else { continue }
            for copy in try pinnedClips(id) {
                copy.isExample = true
                pinnedIDs.insert(id)
            }
        }
        for id in pinboardIDs {
            for record in try pinboardRecords(id) { record.isExample = true }
        }
        try commit()
        if !pinnedIDs.isEmpty || !pinboardIDs.isEmpty { noteCloudWrite(ids: pinnedIDs, pinboards: !pinboardIDs.isEmpty) }
    }

    func hasUntouchedExamples() throws -> Bool {
        // 只按 isExample 取（示例很少），软删除在内存里过滤：谓词里再带 trashedAt，查询计划可能改走 trashedAt 索引、扫全表
        let history = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.isExample == true }))
        if history.contains(where: { $0.trashedAt == nil }) { return true }
        return cache.copies.values.contains { $0.isExample }
    }

    func removeUntouchedExamples() throws {
        let history = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.isExample == true }))
        let pinned = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.isExample == true }))
        let ids = Set(history.map(\.uuid) + pinned.map(\.uuid))
        history.forEach(deleteHistory)
        pinned.forEach { CloudMerge.deletePinned($0, in: cloud) }
        try commit()
        // 示例 Pinboard：没被改过、清完又空了的一并删除；用户往里放了东西的留着
        for record in try cloud.fetch(FetchDescriptor<PinboardRecord>(predicate: #Predicate { $0.isExample == true })) {
            let pinboardID = record.uuid
            let members = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.pinboardID == pinboardID }))
            guard !members.contains(where: { $0.trashedAt == nil }) else { continue }
            members.forEach { CloudMerge.deletePinned($0, in: cloud) }
            cloud.delete(record)
        }
        try commit()
        noteCloudWrite(ids: ids, pinboards: true)
        reindex(ids)
    }

    // MARK: - iCloud 同步：合并别的 Mac 的改动

    /// 同步库 → 本机（收到 iCloud 的导入后、以及每次打开后）：合并去重与取快照在 CloudWorker 上做，
    /// 这里只做本机这一半（History 跟着副本走、换上新的读缓存、更新搜索索引）。几次请求排成一列，一次一个。
    /// 返回数据有没有变化（决定界面要不要重读）
    func syncFromCloud() async -> Bool {
        await enqueueCloudWork { store in await store.runCloudSync() }
    }

    /// 合并一遍并等它做完（测试用，与 syncFromCloud 同一条路；规则见 CloudMerge.dedupeAndSnapshot）
    func mergeCloudChanges() async throws -> Bool {
        await syncFromCloud()
    }

    private func runCloudSync() async -> Bool {
        let generation = cloudGeneration
        syncsInFlight += 1
        defer { syncsInFlight -= 1 }
        do {
            let snapshot = try await worker.dedupeAndSnapshot()
            return try applyCloudSnapshot(snapshot, takenAt: generation)
        } catch {
            Self.log.error("合并同步改动失败：\(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// 同步库的后台活排成一列：前一件做完再做下一件（界面的调用不等它们）
    private func enqueueCloudWork(_ work: @escaping @Sendable (ClipStore) async -> Bool) async -> Bool {
        let previous = cloudWork
        let task = Task(priority: .userInitiated) { [weak self] () -> Bool in
            _ = await previous?.value
            guard let self else { return false }
            return await work(self)
        }
        cloudWork = task
        return await task.value
    }

    /// 本机这一半：History 跟着副本走、换上新的读缓存（快照取走之后本机又写过的以库为准重读）、搜索索引里变过的副本行重写
    private func applyCloudSnapshot(_ snapshot: CloudSnapshot, takenAt generation: Int) throws -> Bool {
        var touched = snapshot.touched
        touched.formUnion(try alignHistoryWithPinned(snapshot.copies))
        try commit()
        installCache(copies: snapshot.copies, pinboards: snapshot.pinboards)
        let later = cloudWrites.filter { $0.generation > generation }
        cloudWrites.removeAll()
        if !later.isEmpty {
            try refreshCachedCopies(later.reduce(into: Set<UUID>()) { $0.formUnion($1.ids) })
            if later.contains(where: \.pinboards) { try refreshCachedPinboards() }
        }
        var changed = snapshot.mergedPinboards
        if try refreshPinnedIndex(touched) || !touched.isEmpty { changed = true }
        if cache.pinboards != mergedPinboards {
            mergedPinboards = cache.pinboards
            changed = true
        }
        return changed
    }

    /// 本机 History 跟着 Pinboard 副本走（副本可能来自别的 Mac）：同一内容、uuid 不同的 History 条目换成副本的 uuid（合成一张卡）；
    /// 标题与"动过"以副本为准（本机改名两边一起改，对不上只能是别的 Mac 改的）。只改本机库。返回涉及的 uuid
    private func alignHistoryWithPinned(_ copies: [PinnedValue]) throws -> Set<UUID> {
        let pinned = copies.sorted(by: CloudMerge.pinnedPrecedes)
        guard !pinned.isEmpty else { return [] }
        let ids = Array(Set(pinned.map(\.uuid)))
        let history = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { ids.contains($0.uuid) }))
        let historyByID = Dictionary(history.map { ($0.uuid, $0) }, uniquingKeysWith: { first, _ in first })
        var touched = Set<UUID>()

        let unmatched = pinned.filter { historyByID[$0.uuid] == nil && !$0.contentHash.isEmpty }
        if !unmatched.isEmpty {
            let hashes = Array(Set(unmatched.map(\.contentHash)))
            let sameContent = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { hashes.contains($0.contentHash) }))
            let byHash = Dictionary(sameContent.map { ($0.contentHash, $0) }, uniquingKeysWith: { first, _ in first })
            for copy in unmatched {
                guard let clip = byHash[copy.contentHash], clip.uuid != copy.uuid else { continue }
                touched.insert(clip.uuid)
                touched.insert(copy.uuid)
                clip.uuid = copy.uuid
                clip.title = copy.title
                if !copy.isExample { clip.isExample = false }
            }
        }

        // 同 uuid 有多份时以排在最前的那份为准（各台 Mac 一致）
        var aligned = Set<UUID>()
        for copy in pinned where aligned.insert(copy.uuid).inserted {
            guard let clip = historyByID[copy.uuid], clip.trashedAt == nil else { continue }
            if clip.title != copy.title {
                clip.title = copy.title
                touched.insert(copy.uuid)
            }
            if clip.isExample, !copy.isExample { clip.isExample = false }
        }
        return touched
    }

    /// 搜索索引：涉及的、以及指纹变了的副本行重写（别的 Mac 改名、挪动、删掉、新收进的）。返回副本有没有变化
    private func refreshPinnedIndex(_ touched: Set<UUID>) throws -> Bool {
        var current: [UUID: String] = [:]
        for (id, copy) in cache.copies { current[id] = Self.signature(copy) }
        let known: [UUID: String]
        do {
            known = try index.pinnedSignatures()
        } catch {
            Self.log.error("读取副本指纹失败，安排修补：\(String(describing: error), privacy: .public)")
            scheduleIndexRepair()
            return true
        }
        guard current != known || !touched.isEmpty else { return false }
        var dirty = touched
        for (id, signature) in current where known[id] != signature { dirty.insert(id) }
        for id in known.keys where current[id] == nil { dirty.insert(id) }
        reindex(dirty)
        guard current != known else { return false }
        do {
            try index.replacePinnedSignatures(current)
        } catch {
            Self.log.error("保存副本指纹失败，安排修补：\(String(describing: error), privacy: .public)")
            scheduleIndexRepair()
        }
        return true
    }

    /// 副本在索引里的指纹：会被别的 Mac 改动的字段（副本的内容不会变）
    private static func signature(_ copy: PinnedValue) -> String {
        "\(rank(copy.lastUsedAt))|\(copy.pinboardID?.uuidString ?? "")|\(copy.pinSortKey)|\(copy.title ?? "")"
    }

    // MARK: - 同步库的读缓存

    /// 不接 iCloud 时（没有系统镜像抢同步库）直接读同步库装缓存；也是后台活失败时的退路
    private func loadCacheDirectly() throws {
        let copies = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.trashedAt == nil })).map(PinnedValue.init)
        let pinboards = CloudMerge.dedupedOrder(try cloud.fetch(FetchDescriptor<PinboardRecord>())).map(CloudMerge.pinboard)
        installCache(copies: copies, pinboards: pinboards)
    }

    private func ensureCacheLoaded() throws {
        guard !cache.copiesLoaded || !cache.pinboardsLoaded else { return }
        try loadCacheDirectly()
    }

    private func installCache(copies: [PinnedValue], pinboards: [Pinboard]) {
        var byID: [UUID: PinnedValue] = [:]
        for copy in copies.sorted(by: CloudMerge.pinnedPrecedes) where byID[copy.uuid] == nil {
            byID[copy.uuid] = copy
        }
        cache.copies = byID
        cache.copiesLoaded = true
        cache.pinboards = pinboards
        cache.pinboardsLoaded = true
        rebuildHashMap()
        // 新复制的条目排在已有副本之后（搜索按时间排序）
        if let newest = copies.map(\.lastUsedAt).max() { lastTimestamp = max(lastTimestamp, newest) }
    }

    private func rebuildHashMap() {
        var map: [String: UUID] = [:]
        for copy in cache.copies.values.sorted(by: CloudMerge.pinnedPrecedes) where !copy.contentHash.isEmpty && map[copy.contentHash] == nil {
            map[copy.contentHash] = copy.uuid
        }
        cache.idByHash = map
    }

    /// 这些 uuid 的副本以同步库为准重读进缓存
    private func refreshCachedCopies(_ ids: Set<UUID>) throws {
        guard !ids.isEmpty else { return }
        let list = Array(ids)
        let values = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { list.contains($0.uuid) }))
            .filter { $0.trashedAt == nil }
            .map(PinnedValue.init)
            .sorted(by: CloudMerge.pinnedPrecedes)
        for id in ids { cache.copies[id] = nil }
        for value in values where cache.copies[value.uuid] == nil { cache.copies[value.uuid] = value }
        rebuildHashMap()
    }

    private func refreshCachedPinboards() throws {
        cache.pinboards = CloudMerge.dedupedOrder(try cloud.fetch(FetchDescriptor<PinboardRecord>())).map(CloudMerge.pinboard)
        cache.pinboardsLoaded = true
    }

    /// 本机刚写了同步库（已保存）：缓存以库为准重读这些；后台快照正在取的话记一笔，装的时候再补
    private func noteCloudWrite(ids: Set<UUID>, pinboards: Bool = false) {
        cloudGeneration += 1
        if syncsInFlight > 0 {
            cloudWrites.append(CloudWrite(generation: cloudGeneration, ids: ids, pinboards: pinboards))
        }
        do {
            try refreshCachedCopies(ids)
            if pinboards { try refreshCachedPinboards() }
        } catch {
            Self.log.error("刷新同步库读缓存失败：\(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - 维护

    /// 物理删除软删除早于 date 的条目（撤销只在本次运行内有效，启动时传 .now 清掉上次留下的全部）。
    /// 本机库这一半当场做；同步库那一半（副本另有 1 小时宽限）与孤儿巡检排进后台，在 CloudWorker 上做，不让界面的调用等它
    func purgeHistoryTrash(olderThan date: Date) throws {
        // 软删除的行很少：先只取标识（走 trashedAt 索引、不读主表），再逐条取出核对时间，每批一个事务
        let ids = try local.fetchIdentifiers(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.trashedAt != nil }))
        for batch in ids.chunked(Self.batchSize) {
            for id in batch {
                guard let clip = local.model(for: id) as? HistoryClip, let trashedAt = clip.trashedAt, trashedAt < date else { continue }
                deleteHistory(clip)
            }
            try commit()
        }
    }

    /// 排一次同步库的维护（不等它做完）
    func scheduleCloudMaintenance(olderThan date: Date) {
        let previous = cloudWork
        cloudWork = Task(priority: .userInitiated) { [weak self] () -> Bool in
            _ = await previous?.value
            await self?.runCloudMaintenance(olderThan: date, now: .now)
            return false
        }
    }

    /// 两个库的软删除一起物理删除，并等同步库那一半做完（测试用；App 走 purgeHistoryTrash + scheduleCloudMaintenance）
    func purgeTrash(olderThan date: Date) async throws {
        try purgeHistoryTrash(olderThan: date)
        _ = await enqueueCloudWork { store in
            await store.runCloudMaintenance(olderThan: date, now: .now)
            return false
        }
    }

    /// 孤儿行巡检（测试用：now 可以拨到将来）
    func sweepOrphans(now: Date) async {
        _ = await enqueueCloudWork { store in
            await store.runCloudMaintenance(olderThan: .distantPast, now: now)
            return false
        }
    }

    /// 同步库的维护：软删除满宽限的副本物理删除；孤儿行巡检（；首装 24 小时内不扫，导入期常有还没到齐的行）：
    /// - 本机库：没有主表的 History payload / 缩略图，直接删（不同步，不会是"还没到齐"）
    /// - 同步库：没有主表的 payload / 缩略图、所属 Pinboard 已不存在的副本，连续 24 小时都是孤儿才处理（见 CloudMerge.maintain）；
    ///   所属 Pinboard 不在了的副本：内容先退回本机 History（不让条目凭空消失），再删掉副本
    private func runCloudMaintenance(olderThan date: Date, now: Date) async {
        let cutoff = min(date, now.addingTimeInterval(-Self.pinnedTrashGrace))
        let sweep = storesAreOlder(than: CloudMerge.orphanGrace, now: now)
        do {
            if sweep {
                let rows = try local.fetchIdentifiers(FetchDescriptor<HistoryPayload>(predicate: #Predicate { $0.clip == nil }))
                    + local.fetchIdentifiers(FetchDescriptor<HistoryThumbnail>(predicate: #Predicate { $0.clip == nil }))
                for id in rows { local.delete(local.model(for: id)) }
                try commit()
            }
            let known = sweep ? (try? index.orphanFirstSeen()) ?? [:] : [:]
            let result = try await worker.maintain(purgeBefore: cutoff, sweep: sweep, now: now, knownOrphans: known)
            if !result.homelessIDs.isEmpty {
                var changedIDs = result.homelessIDs
                for homeless in result.homeless { changedIDs.formUnion(try restoreToHistory(homeless)) }
                try commit()
                try await worker.deleteCopies(result.homelessIDs)
                for id in result.homelessIDs { cache.copies[id] = nil }
                rebuildHashMap()
                reindex(changedIDs)
            }
            if sweep { try? index.replaceOrphanFirstSeen(result.firstSeen) }
        } catch {
            Self.log.error("同步库维护失败：\(String(describing: error), privacy: .public)")
        }
    }

    /// 所属 Pinboard 不在了的副本：本机 History 里看不见它就退回 History（已有同一内容的就改用它的 uuid）。返回涉及的 uuid
    private func restoreToHistory(_ homeless: HomelessCopy) throws -> Set<UUID> {
        let id = homeless.value.uuid
        if let existing = try historyClip(id) {
            existing.trashedAt = nil
            return [id]
        }
        if !homeless.value.contentHash.isEmpty, let sameContent = try historyClip(hash: homeless.value.contentHash) {
            let old = sameContent.uuid
            sameContent.uuid = id
            sameContent.title = homeless.value.title
            sameContent.trashedAt = nil
            return [id, old]
        }
        let clip = HistoryClip()
        Self.copyFields(from: homeless.value, to: clip)
        local.insert(clip)
        if let archive = homeless.payload {
            let payload = HistoryPayload(archive: archive)
            local.insert(payload)
            clip.payload = payload
        }
        if let data = homeless.thumbnail {
            let thumbnail = HistoryThumbnail(data: data)
            local.insert(thumbnail)
            clip.thumbnail = thumbnail
        }
        return [id]
    }

    /// 两个库都建好超过 age 了吗（首装或刚换新库的头一天不巡检孤儿）
    private func storesAreOlder(than age: TimeInterval, now: Date) -> Bool {
        let created = (modelContainer.configurations.map(\.url) + cloudContainer.configurations.map(\.url)).compactMap { url in
            try? url.resourceValues(forKeys: [.creationDateKey]).creationDate
        }
        guard let newest = created.max() else { return false }
        return now.timeIntervalSince(newest) >= age
    }

    /// 清空全部数据（Debug）
    func removeEverything() throws {
        try local.fetch(FetchDescriptor<HistoryClip>()).forEach(deleteHistory)
        try cloud.fetch(FetchDescriptor<PinnedClip>()).forEach { CloudMerge.deletePinned($0, in: cloud) }
        try cloud.fetch(FetchDescriptor<PinboardRecord>()).forEach { cloud.delete($0) }
        try commit()
        noteCloudWrite(ids: Set(cache.copies.keys), pinboards: true)
        do {
            try index.removeAll()
        } catch {
            Self.log.error("清空搜索索引失败，安排修补：\(String(describing: error), privacy: .public)")
            scheduleIndexRepair()
        }
    }

    // MARK: - 搜索索引的后台修补

    /// 修补分三步，每步一批、各是一次独立的 actor 调用（中间让出给其他调用）：
    /// 1. History 按最近使用从新到旧分批写入（索引空了的话，先搜得到最近的内容）
    /// 2. 只在 Pinboard 里的条目写入
    /// 3. 索引里多出来的行（数据里已经没有的）删掉
    /// 修补期间写操作照常更新索引，并记进 seen（第 3 步不会误删它们）
    private struct IndexRepair {
        enum Phase {
            case history(before: Date?)
            case pinned
            case cleanup(after: String?)
        }

        var phase: Phase = .history(before: nil)
        var seen = Set<UUID>()
        /// 修补本身出错时删掉索引文件从头再来，只试一次
        var didReset = false
    }

    /// 搜索索引与数据对不上吗：文件刚重建、上次没修完、或条目数不一致
    func indexNeedsRepair() throws -> Bool {
        if index.wasReset || index.needsRepair { return true }
        try ensureCacheLoaded()
        let historyCount = try local.fetchCount(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.trashedAt == nil }))
        let pinnedIDs = Array(cache.copies.keys)
        var expected = historyCount + pinnedIDs.count
        if !pinnedIDs.isEmpty {
            // 也在 History 里（没删）的只算一次
            expected -= try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { pinnedIDs.contains($0.uuid) }))
                .filter { $0.trashedAt == nil }
                .count
        }
        return try index.count() != expected
    }

    /// 安排一次后台修补（已在修补就不重复）
    private func scheduleIndexRepair() {
        guard repair == nil else { return }
        repair = IndexRepair()
        try? index.setNeedsRepair(true)
        onEvent(.searchIndexRebuilding(true))
        Task.detached(priority: .userInitiated) { [weak self] in
            while let self, await self.indexRepairStep() {
                await Task.yield()
            }
        }
    }

    /// 修补一批；还有活要干返回 true
    func indexRepairStep() -> Bool {
        guard var state = repair else { return false }
        do {
            let more = try autoreleasepool { try advanceRepair(&state) }
            if more {
                repair = state
                return true
            }
            try index.setNeedsRepair(false)
            index.wasReset = false
            repair = nil
            onEvent(.searchIndexRebuilding(false))
            return false
        } catch {
            Self.log.error("修补搜索索引出错：\(String(describing: error), privacy: .public)")
            // 索引库本身坏了：删掉文件从头再来一次；还不行就留着"待修补"，下次启动再试
            if !state.didReset, (try? index.reset()) != nil {
                try? index.setNeedsRepair(true)
                repair = IndexRepair(didReset: true)
                return true
            }
            repair = nil
            onEvent(.searchIndexRebuilding(false))
            return false
        }
    }

    private func advanceRepair(_ state: inout IndexRepair) throws -> Bool {
        switch state.phase {
        case .history(let before):
            var descriptor: FetchDescriptor<HistoryClip>
            if let before {
                descriptor = FetchDescriptor(predicate: #Predicate { $0.trashedAt == nil && $0.lastUsedAt < before }, sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)])
            } else {
                descriptor = FetchDescriptor(predicate: #Predicate { $0.trashedAt == nil }, sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)])
            }
            descriptor.fetchLimit = Self.batchSize
            let clips = try local.fetch(descriptor)
            try index.apply(clips.map { ($0.uuid, Optional(Self.entry($0))) })
            state.seen.formUnion(clips.map(\.uuid))
            state.phase = clips.count < Self.batchSize ? .pinned : .history(before: clips.last?.lastUsedAt)
            return true
        case .pinned:
            // History 里看得见的都已写过（在 seen 里），剩下的就是只在 Pinboard 里的（读缓存）
            try ensureCacheLoaded()
            let entries = cache.copies.values
                .filter { !state.seen.contains($0.uuid) }
                .map { ($0.uuid, Optional(Self.entry($0))) }
            for batch in entries.chunked(Self.batchSize) { try index.apply(Array(batch)) }
            state.seen.formUnion(entries.map(\.0))
            state.phase = .cleanup(after: nil)
            return true
        case .cleanup(let after):
            let limit = Self.batchSize * 4
            let ids = try index.uuids(after: after, limit: limit)
            let stale = ids.filter { !state.seen.contains($0) }
            try index.apply(stale.map { ($0, nil) })
            guard ids.count == limit, let last = ids.last else { return false }
            state.phase = .cleanup(after: last.uuidString)
            return true
        }
    }

    // MARK: - 列表

    private func historyPage(after cursor: ClipCursor?, limit: Int) throws -> ClipPage {
        var descriptor: FetchDescriptor<HistoryClip>
        if let cursor {
            let before = cursor.lastUsedAt
            descriptor = FetchDescriptor(
                predicate: #Predicate { $0.trashedAt == nil && $0.lastUsedAt < before },
                sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)]
            )
        } else {
            descriptor = FetchDescriptor(
                predicate: #Predicate { $0.trashedAt == nil },
                sortBy: [SortDescriptor(\.lastUsedAt, order: .reverse)]
            )
        }
        descriptor.fetchLimit = limit + 1
        let clips = try local.fetch(descriptor)
        let pageClips = Array(clips.prefix(limit))
        let items = pageClips.compactMap { try? snapshot(history: $0, pinned: cache.copies[$0.uuid]) }
        let next = clips.count > limit ? items.last.map { ClipCursor(lastUsedAt: $0.lastUsedAt, id: $0.id) } : nil
        return ClipPage(items: items, nextCursor: next)
    }

    private func pinboardPage(_ pinboardID: UUID) throws -> ClipPage {
        // 读缓存里这个 Pinboard 的副本；排序键相同时按 uuid 定先后（各台 Mac 一致）
        let pinned = cache.copies.values
            .filter { $0.pinboardID == pinboardID }
            .sorted { ($0.pinSortKey, $0.uuid.uuidString) < ($1.pinSortKey, $1.uuid.uuidString) }
        let history = try visibleHistory(pinned.map(\.uuid))
        let items = pinned.compactMap { try? snapshot(history: history[$0.uuid], pinned: $0) }
        return ClipPage(items: items, nextCursor: nil)
    }

    private func searchPage(_ text: String, after cursor: ClipCursor?, limit: Int) throws -> ClipPage {
        let ids = try index.search(SearchFolding.fold(text), after: cursor?.id, limit: limit + 1)
        let pageIDs = Array(ids.prefix(limit))
        let history = try visibleHistory(pageIDs)
        let items = pageIDs.compactMap { try? snapshot(history: history[$0], pinned: cache.copies[$0]) }
        let next = ids.count > limit ? items.last.map { ClipCursor(lastUsedAt: $0.lastUsedAt, id: $0.id) } : nil
        return ClipPage(items: items, nextCursor: next)
    }

    // MARK: - 取对象

    private func fetchFirst<Model: PersistentModel>(_ descriptor: FetchDescriptor<Model>, in context: ModelContext) throws -> Model? {
        var descriptor = descriptor
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }

    /// History 条目（含软删除的）
    private func historyClip(_ id: UUID) throws -> HistoryClip? {
        try fetchFirst(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.uuid == id }), in: local)
    }

    /// 同 uuid 的全部 Pinboard 副本（含软删除的；同步来的可能不止一份）——读同步库
    private func pinnedClips(_ id: UUID) throws -> [PinnedClip] {
        try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.uuid == id }))
    }

    private func visiblePinnedClips(_ id: UUID) throws -> [PinnedClip] {
        try pinnedClips(id).filter { $0.trashedAt == nil }
    }

    /// 读原对象用的那一份副本（取 payload、缩略图）：优先给没删的
    private func pinnedClip(_ id: UUID) throws -> PinnedClip? {
        let matches = try pinnedClips(id)
        return matches.first { $0.trashedAt == nil } ?? matches.first
    }

    /// 同 uuid 的全部 Pinboard 记录（同步来的可能不止一份）——读同步库
    private func pinboardRecords(_ id: UUID) throws -> [PinboardRecord] {
        try cloud.fetch(FetchDescriptor<PinboardRecord>(predicate: #Predicate { $0.uuid == id }))
    }

    /// 同一内容的 History 条目：优先没删的，其次软删除的（重新复制即"复活"它）
    private func historyClip(hash: String) throws -> HistoryClip? {
        let matches = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { $0.contentHash == hash }))
        return matches.first { $0.trashedAt == nil } ?? matches.first
    }

    /// 按 uuid 批量取没删的 History：谓词只用 uuid（走 uuid 索引），软删除在内存里过滤
    private func visibleHistory(_ ids: [UUID]) throws -> [UUID: HistoryClip] {
        guard !ids.isEmpty else { return [:] }
        let clips = try local.fetch(FetchDescriptor<HistoryClip>(predicate: #Predicate { ids.contains($0.uuid) }))
        return Dictionary(clips.filter { $0.trashedAt == nil }.map { ($0.uuid, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private func visible<Clip: StoredClip>(_ clip: Clip?) -> Clip? {
        clip?.trashedAt == nil ? clip : nil
    }

    /// Pinboard 里排最前的排序键（含软删除的：它们也排在那里，新收进的排在它们前面无妨）
    private func firstSortKey(in pinboardID: UUID) throws -> Double {
        let first = try fetchFirst(FetchDescriptor<PinnedClip>(
            predicate: #Predicate { $0.pinboardID == pinboardID },
            sortBy: [SortDescriptor(\.pinSortKey)]
        ), in: cloud)
        return first?.pinSortKey ?? 1
    }

    // MARK: - 写对象

    /// 保存两个库（本机库在前）；失败就回滚，不让没存成的改动留在 context 里被下一次保存捎带（也不让后续读到"没存成的删除"）
    private func commit() throws {
        do {
            if local.hasChanges { try local.save() }
        } catch {
            local.rollback()
            cloud.rollback()
            throw error
        }
        do {
            if cloud.hasChanges { try cloud.save() }
        } catch {
            cloud.rollback()
            throw error
        }
    }

    /// 用户动过的示例就算用户自己的（已经清过的不再写，免得无谓地改同步库）
    private func touch(_ clip: HistoryClip?) {
        if let clip, clip.isExample { clip.isExample = false }
    }

    private func touch(_ copies: [PinnedClip]) {
        for copy in copies where copy.isExample { copy.isExample = false }
    }

    private func historyCopy(of pinned: PinnedClip) throws -> HistoryClip {
        let clip = HistoryClip()
        Self.copyFields(from: pinned, to: clip)
        local.insert(clip)
        if let archive = pinned.payload?.archive {
            let payload = HistoryPayload(archive: archive)
            local.insert(payload)
            clip.payload = payload
        }
        if let data = pinned.thumbnail?.data {
            let thumbnail = HistoryThumbnail(data: data)
            local.insert(thumbnail)
            clip.thumbnail = thumbnail
        }
        return clip
    }

    private func pinnedCopy(of clip: HistoryClip) throws -> PinnedClip {
        let pinned = PinnedClip()
        Self.copyFields(from: clip, to: pinned)
        cloud.insert(pinned)
        if let archive = clip.payload?.archive {
            let payload = PinnedPayload(archive: archive)
            cloud.insert(payload)
            pinned.payload = payload
        }
        if let data = clip.thumbnail?.data {
            let thumbnail = PinnedThumbnail(data: data)
            cloud.insert(thumbnail)
            pinned.thumbnail = thumbnail
        }
        return pinned
    }

    private func replaceContent(of clip: HistoryClip, payload: ClipPayload, thumbnail: Data?) throws {
        if let old = clip.payload { local.delete(old) }
        if let old = clip.thumbnail { local.delete(old) }
        let newPayload = HistoryPayload(archive: try Self.encode(payload))
        local.insert(newPayload)
        clip.payload = newPayload
        if let thumbnail {
            let newThumbnail = HistoryThumbnail(data: thumbnail)
            local.insert(newThumbnail)
            clip.thumbnail = newThumbnail
        } else {
            clip.thumbnail = nil
        }
    }

    /// 物理删除：先删子表再删主表（不靠 cascade）
    private func deleteHistory(_ clip: HistoryClip) {
        if let payload = clip.payload { local.delete(payload) }
        if let thumbnail = clip.thumbnail { local.delete(thumbnail) }
        local.delete(clip)
    }

    // MARK: - 索引

    /// 这些 uuid 的搜索行：两边都看不见了就删掉，否则按最新的标题、内容、时间重写。只查本机库与同步库的读缓存、一个事务；
    /// 失败不影响已保存的数据，记下"待修补"交给后台
    private func reindex(_ ids: some Collection<UUID>) {
        guard !ids.isEmpty else { return }
        let list = Array(Set(ids))
        do {
            let history = try visibleHistory(list)
            try index.apply(list.map { id in
                (id, history[id].map { Self.entry($0) } ?? cache.copies[id].map { Self.entry($0) })
            })
            repair?.seen.formUnion(list)
        } catch {
            Self.log.error("更新搜索索引失败，安排后台修补：\(String(describing: error), privacy: .public)")
            scheduleIndexRepair()
        }
    }

    private static func entry(_ clip: any ClipFields) -> SearchIndex.Entry {
        SearchIndex.Entry(rank: rank(clip.lastUsedAt), body: indexBody(clip))
    }

    private static func indexBody(_ clip: any ClipFields) -> String {
        SearchFolding.fold(clip.title ?? "") + "\n" + clip.searchText
    }

    static func rank(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private func nextTimestamp() -> Date {
        let now = Date.now
        lastTimestamp = now > lastTimestamp.addingTimeInterval(0.001) ? now : lastTimestamp.addingTimeInterval(0.001)
        return lastTimestamp
    }

    // MARK: - 快照

    /// 合成一张卡：History 与 Pinboard 副本同一 uuid；都看不见了就抛 notFound
    private func snapshot(history: HistoryClip?, pinned: PinnedValue?) throws -> ClipItem {
        let clip = visible(history)
        guard let base: any ClipFields = clip ?? pinned.map({ $0 as any ClipFields }) else {
            throw ClipRepositoryError.notFound
        }
        let paths = Self.lines(base.filePathsText)
        return ClipItem(
            id: base.uuid,
            kind: ClipKind(rawValue: base.kindRaw) ?? .text,
            title: clip?.title ?? pinned?.title,
            preview: base.preview,
            characterCount: base.characterCount,
            sourceAppBundleID: base.sourceAppBundleID,
            sourceAppName: base.sourceAppName,
            createdAt: base.createdAt,
            lastUsedAt: base.lastUsedAt,
            isInHistory: clip != nil,
            pinboardID: pinned?.pinboardID,
            pinSortKey: pinned?.pinSortKey,
            colorHex: base.colorHex,
            fileNames: Self.lines(base.fileNamesText),
            imageWidth: base.imageWidth,
            imageHeight: base.imageHeight,
            byteSize: base.byteSize,
            contentHash: base.contentHash,
            isFileMissing: !paths.isEmpty && paths.contains(where: Self.isMissing)
        )
    }

    private static func fill(_ clip: HistoryClip, from draft: ClipDraft) {
        clip.kindRaw = draft.kind.rawValue
        clip.preview = draft.preview
        clip.characterCount = draft.characterCount
        clip.sourceAppBundleID = draft.sourceAppBundleID
        clip.sourceAppName = draft.sourceAppName
        clip.colorHex = draft.colorHex
        clip.fileNamesText = draft.fileNames.joined(separator: "\n")
        clip.filePathsText = draft.filePaths.joined(separator: "\n")
        clip.imageWidth = draft.imageWidth
        clip.imageHeight = draft.imageHeight
        clip.byteSize = draft.byteSize
        clip.contentHash = draft.contentHash
        // 先截再折叠：几十 MB 的文本整段折叠要几百毫秒；折叠可能变长（ß → ss），折完再截一次
        clip.searchText = String(SearchFolding.fold(String(draft.fullText.prefix(searchTextLimit))).prefix(searchTextLimit))
    }

    private static func copyFields(from source: any ClipFields, to target: any StoredClip) {
        target.uuid = source.uuid
        target.createdAt = source.createdAt
        target.lastUsedAt = source.lastUsedAt
        target.kindRaw = source.kindRaw
        target.title = source.title
        target.preview = source.preview
        target.characterCount = source.characterCount
        target.sourceAppBundleID = source.sourceAppBundleID
        target.sourceAppName = source.sourceAppName
        target.colorHex = source.colorHex
        target.fileNamesText = source.fileNamesText
        target.filePathsText = source.filePathsText
        target.imageWidth = source.imageWidth
        target.imageHeight = source.imageHeight
        target.byteSize = source.byteSize
        target.contentHash = source.contentHash
        target.searchText = source.searchText
        target.isExample = source.isExample
    }

    private static func encode(_ payload: ClipPayload) throws -> Data {
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        return try encoder.encode(payload)
    }

    private static func lines(_ text: String) -> [String] {
        text.isEmpty ? [] : text.components(separatedBy: "\n")
    }

    /// 文件还在不在：只问存在与否（access F_OK，不读文件属性）。沙盒挡住的路径返回 EPERM——看不到不等于不存在，
    /// 只有 ENOENT / ENOTDIR 才算"文件已不在"
    private static func isMissing(_ path: String) -> Bool {
        if access(path, F_OK) == 0 { return false }
        return errno == ENOENT || errno == ENOTDIR
    }
}

extension Collection {
    /// 按固定大小切批
    func chunked(_ size: Int) -> [SubSequence] {
        var chunks: [SubSequence] = []
        var start = startIndex
        while start != endIndex {
            let end = index(start, offsetBy: size, limitedBy: endIndex) ?? endIndex
            chunks.append(self[start..<end])
            start = end
        }
        return chunks
    }
}
