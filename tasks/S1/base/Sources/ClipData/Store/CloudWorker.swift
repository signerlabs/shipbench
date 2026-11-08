//
//  CloudWorker.swift
//  ClipData
//
//  同步库（Cloud 库）的后台活：合并别的 Mac 同步来的重复、取回副本与 Pinboard 的快照、物理删除软删除满宽限的副本、巡检孤儿行。
//  同步库被系统的 iCloud 镜像随时读写、占着它自己的 coordinator。这些活放在独立的 actor（自己的执行队列，见 QueueModelExecutor）上做：
//  写入 actor（ClipStore）不用排在它们后面，界面的调用也就不会被"正在等 iCloud"的活拖住。
//  合并规则本身（谁留下、改过的标题留到保留者上）都在 CloudMerge 里，ClipStore 同步执行合并（测试、不同步时）也用它。
//

import Foundation
import SwiftData

/// 一份副本的值快照：读路径（列表、搜索、索引）只用它，不碰同步库
struct PinnedValue: ClipFields, Sendable, Equatable {
    var uuid: UUID
    var createdAt: Date
    var lastUsedAt: Date
    var kindRaw: String
    var title: String?
    var preview: String
    var characterCount: Int
    var sourceAppBundleID: String?
    var sourceAppName: String?
    var colorHex: String?
    var fileNamesText: String
    var filePathsText: String
    var imageWidth: Int?
    var imageHeight: Int?
    var byteSize: Int
    var contentHash: String
    var searchText: String
    var isExample: Bool
    var pinboardID: UUID?
    var pinSortKey: Double

    init(_ copy: PinnedClip) {
        uuid = copy.uuid
        createdAt = copy.createdAt
        lastUsedAt = copy.lastUsedAt
        kindRaw = copy.kindRaw
        title = copy.title
        preview = copy.preview
        characterCount = copy.characterCount
        sourceAppBundleID = copy.sourceAppBundleID
        sourceAppName = copy.sourceAppName
        colorHex = copy.colorHex
        fileNamesText = copy.fileNamesText
        filePathsText = copy.filePathsText
        imageWidth = copy.imageWidth
        imageHeight = copy.imageHeight
        byteSize = copy.byteSize
        contentHash = copy.contentHash
        searchText = copy.searchText
        isExample = copy.isExample
        pinboardID = copy.pinboardID
        pinSortKey = copy.pinSortKey
    }
}

/// 合并去重之后的同步库快照
struct CloudSnapshot: Sendable {
    /// 没删的全部副本（同 uuid 可能不止一份，装进缓存时按合并规则只留一份）
    let copies: [PinnedValue]
    /// 排好序、同 uuid 只留一份的 Pinboard
    let pinboards: [Pinboard]
    /// 合并涉及的 uuid（保留者与被删的重复）
    let touched: Set<UUID>
    /// 合并掉了重复的 Pinboard
    let mergedPinboards: Bool
}

/// 所属 Pinboard 已不在、连续 24 小时都是孤儿的副本：内容先退回本机 History，再删掉
struct HomelessCopy: Sendable {
    let value: PinnedValue
    let payload: Data?
    let thumbnail: Data?
}

/// 一次同步库维护的结果
struct CloudMaintenance: Sendable {
    /// 该退回 History 再删的副本（每个 uuid 一份；全被软删除的不在这里，但 uuid 在 homelessIDs 里一并删）
    let homeless: [HomelessCopy]
    let homelessIDs: Set<UUID>
    /// 还在观察中的孤儿行与各自第一次被看到的时间（不含这次要处理的）
    let firstSeen: [String: Date]
}

/// 同步库的合并规则与读写工具（ClipStore 与 CloudWorker 共用，只碰传进来的同步库 context）
enum CloudMerge {

    static let orphanGrace: TimeInterval = 24 * 3600

    /// 合并重复（ Y2，§11 #34）并取回快照：
    /// - 同一 uuid 的 Pinboard（两台 Mac 各装了一份示例）、同一内容的副本（两台 Mac 各收了一次）只留最早创建的一份，
    ///   各台 Mac 按同一规则选出同一个保留者，结果收敛；被删那份上用户改过的名字、标题留到保留者上
    /// - 每组重复都是"改之前重取、改完立刻保存"：同步库随时可能被系统改写，不拿着旧对象改（SwiftData 保存时整行覆盖）
    static func dedupeAndSnapshot(in context: ModelContext) throws -> CloudSnapshot {
        let mergedPinboards = try mergeDuplicatePinboards(in: context)
        let touched = try mergeDuplicatePinnedClips(in: context)
        let copies = try context.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.trashedAt == nil })).map(PinnedValue.init)
        let pinboards = dedupedOrder(try context.fetch(FetchDescriptor<PinboardRecord>())).map(pinboard)
        return CloudSnapshot(copies: copies, pinboards: pinboards, touched: touched, mergedPinboards: mergedPinboards)
    }

    /// 同一 uuid 的 Pinboard 留最早创建的那份；保留者还是没动过的示例、而另一份被用户改过（改名、改色、挪动），用改过的名字、颜色与位置
    private static func mergeDuplicatePinboards(in context: ModelContext) throws -> Bool {
        let duplicated = Dictionary(grouping: try context.fetch(FetchDescriptor<PinboardRecord>()), by: \.uuid)
            .filter { $0.value.count > 1 }
            .keys
        var changed = false
        for id in duplicated {
            let group = try context.fetch(FetchDescriptor<PinboardRecord>(predicate: #Predicate { $0.uuid == id }))
            guard group.count > 1 else { continue }
            let ordered = group.sorted(by: pinboardPrecedes)
            // 完全相同、比不出先后：不删（否则两台 Mac 可能各删一份、一份不剩），读取时按 uuid 只显示一份
            guard pinboardPrecedes(ordered[0], ordered[1]) else { continue }
            let keeper = ordered[0]
            if keeper.isExample, let edited = ordered.dropFirst().first(where: { !$0.isExample }) {
                keeper.name = edited.name
                keeper.colorRaw = edited.colorRaw
                keeper.sortKey = edited.sortKey
                keeper.isExample = false
            }
            ordered.dropFirst().forEach { context.delete($0) }
            try commit(context)
            changed = true
        }
        return changed
    }

    /// 同一内容的副本（没删的）留最早创建的那份。保留者是没动过的示例、另一份被用户改过（改名、挪到别的 Pinboard），
    /// 用改过的那份的标题与位置（与 Pinboard 的规则一致）；否则保留者没有标题就用另一份的；任何一份被用户动过、保留者也算动过。
    /// 返回涉及的 uuid
    private static func mergeDuplicatePinnedClips(in context: ModelContext) throws -> Set<UUID> {
        let pinned = try context.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.trashedAt == nil }))
        let hashes = Dictionary(grouping: pinned, by: \.contentHash)
            .filter { !$0.key.isEmpty && $0.value.count > 1 }
            .keys
        var touched = Set<UUID>()
        for hash in hashes {
            let group = try context.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.contentHash == hash }))
                .filter { $0.trashedAt == nil }
            guard group.count > 1 else { continue }
            let ordered = group.sorted(by: pinnedPrecedes)
            guard pinnedPrecedes(ordered[0], ordered[1]) else { continue }
            let keeper = ordered[0]
            let rest = ordered.dropFirst()
            if keeper.isExample, let edited = rest.first(where: { !$0.isExample }) {
                keeper.title = edited.title
                keeper.pinboardID = edited.pinboardID
                keeper.pinSortKey = edited.pinSortKey
                keeper.isExample = false
            }
            for duplicate in rest {
                if keeper.title == nil, let title = duplicate.title { keeper.title = title }
                if !duplicate.isExample { keeper.isExample = false }
                touched.insert(duplicate.uuid)
                deletePinned(duplicate, in: context)
            }
            touched.insert(keeper.uuid)
            try commit(context)
        }
        return touched
    }

    // MARK: - 先后规则

    /// 合并时谁留下：最早创建的；再依次比其余字段，各台 Mac 比出同一个。
    /// 时间按整秒比：经 iCloud 同步来的日期精度不如本机原值（毫秒级取整方式待真机核实），比到秒以下两台 Mac 可能比出不同的保留者、
    /// 结果两份都被删；同一秒内的交给后面的字段（uuid 等）决定
    static func pinboardPrecedes(_ a: PinboardRecord, _ b: PinboardRecord) -> Bool {
        (a.createdAt, a.sortKey, a.name, a.colorRaw) < (b.createdAt, b.sortKey, b.name, b.colorRaw)
    }

    static func pinnedPrecedes(_ a: PinnedClip, _ b: PinnedClip) -> Bool {
        pinnedPrecedes(PinnedValue(a), PinnedValue(b))
    }

    static func pinnedPrecedes(_ a: PinnedValue, _ b: PinnedValue) -> Bool {
        (a.createdAt, a.uuid.uuidString, a.pinboardID?.uuidString ?? "", a.pinSortKey, a.lastUsedAt, a.title ?? "")
            < (b.createdAt, b.uuid.uuidString, b.pinboardID?.uuidString ?? "", b.pinSortKey, b.lastUsedAt, b.title ?? "")
    }

    /// 排好序、同 uuid 只留一份的 Pinboard：按排序键，相同再按 uuid（各台 Mac 排出同一个顺序）
    static func dedupedOrder(_ records: [PinboardRecord]) -> [PinboardRecord] {
        var seen = Set<UUID>()
        return records
            .sorted { ($0.sortKey, $0.uuid.uuidString) < ($1.sortKey, $1.uuid.uuidString) }
            .filter { seen.insert($0.uuid).inserted }
    }

    static func pinboard(_ record: PinboardRecord) -> Pinboard {
        Pinboard(id: record.uuid, name: record.name, color: PinboardColor(rawValue: record.colorRaw) ?? .blue, sortKey: record.sortKey)
    }

    // MARK: - 写

    /// 保存；失败就回滚，不让没存成的改动留在 context 里被下一次保存捎带
    static func commit(_ context: ModelContext) throws {
        guard context.hasChanges else { return }
        do {
            try context.save()
        } catch {
            context.rollback()
            throw error
        }
    }

    /// 物理删除：先删子表再删主表（不靠 cascade）
    static func deletePinned(_ pinned: PinnedClip, in context: ModelContext) {
        if let payload = pinned.payload { context.delete(payload) }
        if let thumbnail = pinned.thumbnail { context.delete(thumbnail) }
        context.delete(pinned)
    }

    // MARK: - 维护

    /// 物理删除软删除早于 cutoff 的副本；sweep 时再巡检孤儿行（连续 24 小时都是孤儿才处理，导入是分批的，刚看到的多半只是还没到齐）：
    /// 没有主表的 payload / 缩略图直接删；所属 Pinboard 不在了的副本交回调用方（先退回 History，再用 deleteCopies 删）
    static func maintain(in context: ModelContext, purgeBefore cutoff: Date, sweep: Bool, now: Date, knownOrphans: [String: Date]) throws -> CloudMaintenance {
        // 软删除的行很少：只取标识（走 trashedAt 索引、不读主表），再逐条取出核对时间，每批一个事务
        let trashed = try context.fetchIdentifiers(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.trashedAt != nil }))
        for batch in trashed.chunked(ClipStore.batchSize) {
            for id in batch {
                guard let copy = context.model(for: id) as? PinnedClip, let trashedAt = copy.trashedAt, trashedAt < cutoff else { continue }
                deletePinned(copy, in: context)
            }
            try commit(context)
        }
        guard sweep else { return CloudMaintenance(homeless: [], homelessIDs: [], firstSeen: knownOrphans) }

        var seen: [String: Date] = [:]
        /// 记下第一次看到的时间；已满 24 小时返回 true
        func isDue(_ key: String) -> Bool {
            let first = knownOrphans[key] ?? now
            seen[key] = first
            return now.timeIntervalSince(first) >= orphanGrace
        }
        let rows = try context.fetchIdentifiers(FetchDescriptor<PinnedPayload>(predicate: #Predicate { $0.clip == nil }))
            + context.fetchIdentifiers(FetchDescriptor<PinnedThumbnail>(predicate: #Predicate { $0.clip == nil }))
        for id in rows {
            guard let key = orphanKey(id), isDue(key) else { continue }
            context.delete(context.model(for: id))
            seen[key] = nil
        }
        try commit(context)

        let pinboardIDs = Set(try context.fetch(FetchDescriptor<PinboardRecord>()).map(\.uuid))
        let homeless = try context.fetch(FetchDescriptor<PinnedClip>())
            .filter { copy in copy.pinboardID.map { !pinboardIDs.contains($0) } ?? true }
        var due: [HomelessCopy] = []
        var dueIDs = Set<UUID>()
        for (id, copies) in Dictionary(grouping: homeless, by: \.uuid) {
            guard isDue("pinned:" + id.uuidString) else { continue }
            dueIDs.insert(id)
            if let source = copies.filter({ $0.trashedAt == nil }).sorted(by: pinnedPrecedes).first {
                due.append(HomelessCopy(value: PinnedValue(source), payload: source.payload?.archive, thumbnail: source.thumbnail?.data))
            }
        }
        // 这次要处理的不再记（删成功后就不是孤儿了；删失败下次重新开始计时也无妨）
        for id in dueIDs { seen["pinned:" + id.uuidString] = nil }
        return CloudMaintenance(homeless: due, homelessIDs: dueIDs, firstSeen: seen)
    }

    /// 删掉这些 uuid 的全部副本（含软删除的）
    static func deleteCopies(_ ids: Set<UUID>, in context: ModelContext) throws {
        guard !ids.isEmpty else { return }
        let list = Array(ids)
        for copy in try context.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { list.contains($0.uuid) })) {
            deletePinned(copy, in: context)
        }
        try commit(context)
    }

    /// 孤儿 payload / 缩略图的记录键（库内标识编码成文本；键排好序，每次编码结果一样）
    static func orphanKey(_ id: PersistentIdentifier) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard let data = try? encoder.encode(id) else { return nil }
        return "row:" + data.base64EncodedString()
    }
}

/// 同步库的后台 actor：自己的 context、自己的串行执行器（不在 Swift 并发的线程池里等 iCloud）
actor CloudWorker: ModelActor {
    /// 执行器：自己的串行队列（见 QueueModelExecutor）
    nonisolated let executor: QueueModelExecutor
    nonisolated var modelExecutor: any ModelExecutor { executor }
    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }
    nonisolated let modelContainer: ModelContainer

    /// 须在主线程之外创建（与 ClipStore 一样，ModelContext 在主线程创建会绑在主队列上）
    init(container: ModelContainer) {
        let context = ModelContext(container)
        context.autosaveEnabled = false
        executor = QueueModelExecutor(modelContext: context, label: "com.example.clipapp.cloud")
        modelContainer = container
    }

    func dedupeAndSnapshot() throws -> CloudSnapshot {
        try CloudMerge.dedupeAndSnapshot(in: modelContext)
    }

    func maintain(purgeBefore cutoff: Date, sweep: Bool, now: Date, knownOrphans: [String: Date]) throws -> CloudMaintenance {
        try CloudMerge.maintain(in: modelContext, purgeBefore: cutoff, sweep: sweep, now: now, knownOrphans: knownOrphans)
    }

    func deleteCopies(_ ids: Set<UUID>) throws {
        try CloudMerge.deleteCopies(ids, in: modelContext)
    }
}
