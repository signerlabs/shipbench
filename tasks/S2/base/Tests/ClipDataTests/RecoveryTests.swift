//
//  RecoveryTests.swift
//  ClipDataTests
//
//  库文件出问题时的处理（用户 2026-10-10 定的规则）与搜索索引的后台修补：
//  索引坏了静默重建、索引与数据对不上后台修补、主库坏了挪进备份目录开新库、同步库接不上 iCloud 就本次不同步、暂时打不开就退避重试。
//

import Foundation
import os
import SQLite3
import SwiftData
import Testing
@testable import ClipData

@Suite struct RecoveryTests {

    // MARK: - 工具

    private func makeDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "ClipAppRecoveryTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    private func text(_ string: String) -> ClipDraft {
        ClipDraft(
            kind: .text, preview: string, fullText: string, characterCount: string.count,
            byteSize: string.utf8.count, contentHash: "text:" + string,
            payload: ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(string.utf8))]])
        )
    }

    private func search(_ repository: SwiftDataClipRepository, _ needle: String) async throws -> [ClipItem] {
        try await repository.page(ClipQuery(scope: .history, searchText: needle), after: nil, limit: 100).items
    }

    private func search(_ store: ClipStore, _ needle: String) async throws -> [ClipItem] {
        try await store.page(ClipQuery(scope: .history, searchText: needle), after: nil, limit: 100).items
    }

    /// 收集事件直到满足条件（或超时）
    private func collect(_ stream: AsyncStream<StoreEvent>, timeout: Duration = .seconds(30), until done: @escaping @Sendable (StoreEvent) -> Bool) async -> [StoreEvent] {
        await withTaskGroup(of: [StoreEvent]?.self) { group in
            group.addTask {
                var seen: [StoreEvent] = []
                for await event in stream {
                    seen.append(event)
                    if done(event) { return seen }
                }
                return seen
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first ?? []
        }
    }

    // MARK: - 搜索索引

    @Test func corruptedSearchIndexIsRebuiltInBackground() async throws {
        let directory = makeDirectory()
        do {
            let store = try ClipStore.make(directory: directory)
            try await store.prepare()
            for word in ["alpha one", "beta two", "gamma three"] { _ = try await store.ingest(text(word)) }
        }
        // 索引文件坏了（不是 SQLite 格式）
        let indexURL = directory.appending(path: StoreFiles.searchIndexName)
        SearchIndex.removeFiles(at: indexURL)
        try Data(repeating: 0x5A, count: 8192).write(to: indexURL)

        let repository = SwiftDataClipRepository(directory: directory)
        let events = await collect(repository.storeEvents) { $0 == .searchIndexRebuilding(false) }
        #expect(events.first == .available)
        #expect(events.contains(.searchIndexRebuilding(true)))
        #expect(events.last == .searchIndexRebuilding(false))
        #expect(try await search(repository, "gamma").map(\.preview) == ["gamma three"])
        #expect(try await search(repository, "alpha").count == 1)
        #expect(try await repository.currentStore().indexNeedsRepair() == false)
    }

    @Test func consistencyCheckRepairsMissingAndStaleRows() async throws {
        let (stream, continuation) = AsyncStream.makeStream(of: StoreEvent.self)
        let store = try ClipStore.make(directory: makeDirectory(), onEvent: { continuation.yield($0) })
        try await store.prepare()
        var ids: [UUID] = []
        for index in 1...6 { ids.append(try await store.ingest(text("entry number \(index)")).id) }
        #expect(try await store.indexNeedsRepair() == false)

        // 索引丢了两行、多了一行数据里没有的（比如崩在保存与写索引之间）
        try await store.debugApplyToIndex([(ids[0], nil), (ids[3], nil), (UUID(), SearchIndex.Entry(rank: 1, body: "ghost entry"))])
        #expect(try await store.indexNeedsRepair())
        await store.startBackgroundWork()
        let events = await collect(stream) { $0 == .searchIndexRebuilding(false) }
        #expect(events == [.searchIndexRebuilding(true), .searchIndexRebuilding(false)])
        #expect(try await store.indexNeedsRepair() == false)
        #expect(Set(try await search(store, "entry number").map(\.id)) == Set(ids))
        #expect(try await search(store, "ghost").isEmpty)
    }

    // MARK: - 库文件

    @Test func corruptedLocalStoreIsMovedAside() async throws {
        let directory = makeDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(repeating: 0x41, count: 8192).write(to: directory.appending(path: StoreFiles.localName))

        let repository = SwiftDataClipRepository(directory: directory)
        let events = await collect(repository.storeEvents) { $0 == .available }
        guard case .recovered(let backup, let historyReset, let pinboardsReset)? = events.first else {
            Issue.record("没有 recovered 事件：\(events)")
            return
        }
        #expect(historyReset)
        #expect(!pinboardsReset)
        #expect(backup.lastPathComponent.hasPrefix("Recovered-"))
        #expect(FileManager.default.fileExists(atPath: backup.appending(path: StoreFiles.localName).path(percentEncoded: false)))
        #expect(events.last == .available)

        let item = try await repository.ingest(text("after recovery"))
        #expect(try await repository.page(ClipQuery(scope: .history), after: nil, limit: 10).items.map(\.id) == [item.id])
    }

    @Test func storesFromCombinedContainerOpenWithSplitContainers() async throws {
        let directory = makeDirectory()
        let boardID = UUID()
        let bothID = UUID()
        let pinnedOnlyID = UUID()
        let historyOnlyID = UUID()
        func archive(_ text: String) throws -> Data {
            try PropertyListEncoder().encode(ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(text.utf8))]]))
        }
        // 旧版建的库：一个 ModelContainer 挂两个配置（History 与 Pinboard 共用一个 coordinator）
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let local = ModelConfiguration(
                "Local",
                schema: Schema([HistoryClip.self, HistoryPayload.self, HistoryThumbnail.self]),
                url: directory.appending(path: StoreFiles.localName),
                cloudKitDatabase: .none
            )
            let cloud = ModelConfiguration(
                "Cloud",
                schema: Schema([PinboardRecord.self, PinnedClip.self, PinnedPayload.self, PinnedThumbnail.self]),
                url: directory.appending(path: StoreFiles.cloudName),
                cloudKitDatabase: .none
            )
            let container = try ModelContainer(
                for: Schema(versionedSchema: ClipAppSchemaV1.self),
                migrationPlan: ClipAppMigrationPlan.self,
                configurations: [local, cloud]
            )
            let context = ModelContext(container)
            let board = PinboardRecord()
            board.uuid = boardID
            board.name = "Saved"
            context.insert(board)
            // History 里的两条：一条只在 History，一条也收进了 Pinboard
            let older = HistoryClip()
            older.uuid = historyOnlyID
            older.preview = "history only"
            older.contentHash = "text:history only"
            older.searchText = "history only"
            older.lastUsedAt = .now.addingTimeInterval(-60)
            context.insert(older)
            let clip = HistoryClip()
            clip.uuid = bothID
            clip.preview = "kept in both"
            clip.contentHash = "text:kept in both"
            clip.searchText = "kept in both"
            context.insert(clip)
            let payload = HistoryPayload(archive: try archive("kept in both"))
            context.insert(payload)
            clip.payload = payload
            let copy = PinnedClip()
            copy.uuid = bothID
            copy.preview = "kept in both"
            copy.contentHash = "text:kept in both"
            copy.searchText = "kept in both"
            copy.pinboardID = boardID
            context.insert(copy)
            // 只在 Pinboard 里的一条，带内容与缩略图
            let only = PinnedClip()
            only.uuid = pinnedOnlyID
            only.preview = "only pinned"
            only.contentHash = "text:only pinned"
            only.searchText = "only pinned"
            only.pinboardID = boardID
            only.pinSortKey = -1
            context.insert(only)
            let onlyPayload = PinnedPayload(archive: try archive("only pinned"))
            context.insert(onlyPayload)
            only.payload = onlyPayload
            let thumbnail = PinnedThumbnail(data: Data([1, 2, 3]))
            context.insert(thumbnail)
            only.thumbnail = thumbnail
            try context.save()
        }

        // 新版：两个库各开一个 ModelContainer，不迁移、不挪文件、数据都在
        let repository = SwiftDataClipRepository(directory: directory)
        let events = await collect(repository.storeEvents) { $0 == .searchIndexRebuilding(false) }
        #expect(events.first == .available)
        #expect(!events.contains { if case .recovered = $0 { true } else { false } })
        #expect(try await repository.pinboards().map(\.name) == ["Saved"])
        let history = try await repository.page(ClipQuery(scope: .history), after: nil, limit: 10).items
        #expect(history.map(\.id) == [bothID, historyOnlyID])
        #expect(history.first?.pinboardID == boardID)
        let inBoard = try await repository.page(ClipQuery(scope: .pinboard(boardID)), after: nil, limit: 10).items
        #expect(inBoard.map(\.id) == [pinnedOnlyID, bothID])
        #expect(try await repository.payload(for: pinnedOnlyID).items.first?.first?.data == Data("only pinned".utf8))
        #expect(try await repository.payload(for: bothID).items.first?.first?.data == Data("kept in both".utf8))
        #expect(await repository.thumbnail(for: pinnedOnlyID) == Data([1, 2, 3]))
        #expect(try await search(repository, "only pinned").map(\.id) == [pinnedOnlyID])
        #expect(try await search(repository, "kept").map(\.id) == [bothID])
        #expect(try await search(repository, "history only").map(\.id) == [historyOnlyID])

        // 新版写过之后再开一次，照样都在
        let added = try await repository.ingest(text("added after split"))
        _ = try await repository.pin(added.id, to: boardID)
        let reopened = SwiftDataClipRepository(directory: directory)
        #expect(try await reopened.historyCount(before: nil) == 3)
        #expect(Set(try await reopened.page(ClipQuery(scope: .pinboard(boardID)), after: nil, limit: 10).items.map(\.id)) == [pinnedOnlyID, bothID, added.id])
    }

    @Test func corruptedCloudStoreIsMovedAsideAndHistoryKept() async throws {
        let directory = makeDirectory()
        do {
            let store = try ClipStore.make(directory: directory)
            try await store.prepare()
            _ = try await store.ingest(text("history survives"))
        }
        // 只有同步库坏了：只挪它，History 原样留着
        try Data(repeating: 0x42, count: 8192).write(to: directory.appending(path: StoreFiles.cloudName))
        for suffix in ["-wal", "-shm"] { try? FileManager.default.removeItem(at: directory.appending(path: StoreFiles.cloudName + suffix)) }

        let repository = SwiftDataClipRepository(directory: directory)
        let events = await collect(repository.storeEvents) { $0 == .available }
        guard case .recovered(let backup, let historyReset, let pinboardsReset)? = events.first else {
            Issue.record("没有 recovered 事件：\(events)")
            return
        }
        #expect(!historyReset)
        #expect(pinboardsReset)
        #expect(FileManager.default.fileExists(atPath: backup.appending(path: StoreFiles.cloudName).path(percentEncoded: false)))
        #expect(!FileManager.default.fileExists(atPath: backup.appending(path: StoreFiles.localName).path(percentEncoded: false)))
        #expect(try await repository.page(ClipQuery(scope: .history), after: nil, limit: 10).items.map(\.preview) == ["history survives"])
        let board = try await repository.createPinboard(name: "Fresh", color: .blue)
        #expect(try await repository.pinboards().map(\.id) == [board.id])
    }

    @Test func corruptedCloudStoreWithBrokenICloudRecoversWithoutSync() async throws {
        let directory = makeDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(repeating: 0x43, count: 8192).write(to: directory.appending(path: StoreFiles.cloudName))
        let (stream, continuation) = AsyncStream.makeStream(of: StoreEvent.self)
        // 同步库文件坏了，而且接 iCloud 也出错（测试进程里不能真连 CloudKit）：挪走换新，本次不同步
        let host = StoreHost(directory: directory, cloudKitContainer: "iCloud.test.clipapp", events: continuation, firstRetryDelay: .milliseconds(50)) { directory, cloud, configuration in
            if cloud != nil { throw CocoaError(.featureUnsupported) }
            return try StoreFiles.makeContainer(directory: directory, cloudKitContainer: nil, for: configuration)
        }
        let store = try await host.store()
        let events = await collect(stream) { $0 == .available }
        #expect(events.count == 3)
        guard case .recovered(_, let historyReset, let pinboardsReset)? = events.first else {
            Issue.record("没有 recovered 事件：\(events)")
            return
        }
        #expect(!historyReset)
        #expect(pinboardsReset)
        guard events.count == 3, case .cloudDisabled = events[1] else {
            Issue.record("没有 cloudDisabled 事件：\(events)")
            return
        }
        #expect(events[2] == .available)
        _ = try await store.createPinboard(id: UUID(), name: "Local only", color: .green)
        #expect(try await store.pinboards().map(\.name) == ["Local only"])
    }

    @Test func cloudStoreFailureFallsBackToLocalOnly() async throws {
        let directory = makeDirectory()
        let (stream, continuation) = AsyncStream.makeStream(of: StoreEvent.self)
        // 模拟接 iCloud 的配置打不开（测试进程里不能真连 CloudKit）
        let host = StoreHost(directory: directory, cloudKitContainer: "iCloud.test.clipapp", events: continuation, firstRetryDelay: .milliseconds(50)) { directory, cloud, only in
            if cloud != nil { throw CocoaError(.featureUnsupported) }
            return try StoreFiles.makeContainer(directory: directory, cloudKitContainer: nil, for: only)
        }
        let store = try await host.store()
        let events = await collect(stream) { $0 == .available }
        guard case .cloudDisabled? = events.first else {
            Issue.record("没有 cloudDisabled 事件：\(events)")
            return
        }
        #expect(events.last == .available)
        #expect(await host.cloudDisabledReason != nil)
        // History 与本机的 Pinboard 照常可用
        let board = try await store.createPinboard(id: UUID(), name: "Local", color: .blue)
        let item = try await store.ingest(text("still works"))
        _ = try await store.pin(item.id, to: board.id)
        #expect(try await store.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 10).items.map(\.id) == [item.id])
        // 没挪任何文件
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        #expect(!contents.contains { $0.hasPrefix("Recovered-") })
    }

    @Test func transientFailuresAreRetriedWithoutMovingFiles() async throws {
        let directory = makeDirectory()
        let (stream, continuation) = AsyncStream.makeStream(of: StoreEvent.self)
        // 前 3 次建 container 都失败（如磁盘出错），之后恢复正常
        let failures = OSAllocatedUnfairLock(initialState: 3)
        let host = StoreHost(directory: directory, cloudKitContainer: nil, events: continuation, firstRetryDelay: .milliseconds(50)) { directory, cloud, only in
            let fail = failures.withLock { remaining in
                defer { remaining -= 1 }
                return remaining > 0
            }
            if fail { throw CocoaError(.fileWriteUnknown) }
            return try StoreFiles.makeContainer(directory: directory, cloudKitContainer: cloud, for: only)
        }
        await #expect(throws: ClipRepositoryError.self) {
            _ = try await host.store()
        }
        let events = await collect(stream) { $0 == .available }
        #expect(events.count { if case .unavailable = $0 { true } else { false } } >= 1)
        #expect(events.last == .available)
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false))
        #expect(!contents.contains { $0.hasPrefix("Recovered-") })
        let store = try await host.store()
        _ = try await store.ingest(text("after retry"))
        #expect(try await store.historyCount(before: nil) == 1)
    }

    // MARK: - 孤儿行

    @Test func orphanRowsAreSweptOnlyAfterGracePeriods() async throws {
        let store = try ClipStore.make(directory: makeDirectory())
        try await store.prepare()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let kept = try await store.ingest(text("kept in board"))
        _ = try await store.pin(kept.id, to: board.id)
        let homelessID = UUID()
        try await store.insertOrphans(homelessID: homelessID, text: "homeless note")
        let start = Date.now

        // 首装 24 小时内不动
        await store.sweepOrphans(now: start)
        #expect(try await store.orphanCounts() == .init(localRows: 1, cloudRows: 1, homeless: 1))

        // 过了首装期：本机的孤儿直接删；同步库的先记下，还不动（可能只是导入没到齐）
        await store.sweepOrphans(now: start.addingTimeInterval(25 * 3600))
        #expect(try await store.orphanCounts() == .init(localRows: 0, cloudRows: 1, homeless: 1))

        // 连续 24 小时都是孤儿：删掉；Pinboard 已不在的副本退回 History
        await store.sweepOrphans(now: start.addingTimeInterval(50 * 3600))
        let afterTwoDays = try await store.orphanCounts()
        #expect(afterTwoDays == .init(localRows: 0, cloudRows: 0, homeless: 0))
        let history = try await store.page(ClipQuery(scope: .history), after: nil, limit: 10).items
        #expect(Set(history.map(\.id)) == [kept.id, homelessID])
        #expect(try await search(store, "homeless").map(\.id) == [homelessID])
        // 好好在 Pinboard 里的不受影响
        #expect(try await store.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 10).items.map(\.id) == [kept.id])
    }

    @Test func searchIndexFromOlderVersionIsUpgradedInPlace() throws {
        // 早期版本的索引文件没有 meta 表（user_version = 0）：原地补建，不当成坏文件、不重建
        let url = makeDirectory().appending(path: StoreFiles.searchIndexName)
        do {
            let index = try SearchIndex(url: url)
            try index.apply([(UUID(), SearchIndex.Entry(rank: 10, body: "kept row"))])
        }
        var db: OpaquePointer?
        #expect(sqlite3_open_v2(url.path(percentEncoded: false), &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        #expect(sqlite3_exec(db, "DROP TABLE meta; PRAGMA user_version = 0", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(db)

        let reopened = try SearchIndex.open(url: url)
        #expect(reopened.wasReset == false)
        #expect(try reopened.count() == 1)
        try reopened.setNeedsRepair(true)
        #expect(reopened.needsRepair)
    }
}

struct OrphanCounts: Equatable {
    let localRows: Int
    let cloudRows: Int
    let homeless: Int
}

extension ClipStore {
    /// 直接改搜索索引（模拟索引与数据对不上）
    func debugApplyToIndex(_ changes: [(UUID, SearchIndex.Entry?)]) throws {
        try index.apply(changes)
    }

    /// 造孤儿：没有主表的 History payload 与 Pinboard payload、所属 Pinboard 不存在的副本
    func insertOrphans(homelessID: UUID, text: String) throws {
        modelContext.insert(HistoryPayload(archive: Data("orphan".utf8)))
        try modelContext.save()
        cloud.insert(PinnedPayload(archive: Data("orphan".utf8)))
        let copy = PinnedClip()
        copy.uuid = homelessID
        copy.preview = text
        copy.contentHash = "text:" + text
        copy.searchText = SearchFolding.fold(text)
        copy.pinboardID = UUID()
        cloud.insert(copy)
        try cloud.save()
    }

    func orphanCounts() throws -> OrphanCounts {
        let boards = Set(try cloud.fetch(FetchDescriptor<PinboardRecord>()).map(\.uuid))
        return OrphanCounts(
            localRows: try modelContext.fetchCount(FetchDescriptor<HistoryPayload>(predicate: #Predicate { $0.clip == nil })),
            cloudRows: try cloud.fetchCount(FetchDescriptor<PinnedPayload>(predicate: #Predicate { $0.clip == nil })),
            homeless: try cloud.fetch(FetchDescriptor<PinnedClip>()).filter { $0.pinboardID.map { !boards.contains($0) } ?? true }.count
        )
    }
}
