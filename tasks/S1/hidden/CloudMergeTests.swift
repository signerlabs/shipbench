//
//  CloudMergeTests.swift
//  ClipDataTests
//
//  iCloud 同步后的合并：把"别的 Mac 同步来的记录"直接写进同步库（系统导入时也是这样绕过写入接口），
//  再跑 mergeCloudChanges（与后台的 syncFromCloud 同一套规则与本机处理），看合并去重、History 对齐、读缓存与搜索索引。
//

import Foundation
import SwiftData
import Testing
@testable import ClipData

@Suite struct CloudMergeTests {

    // MARK: - 工具

    private func makeStore() async throws -> ClipStore {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ClipAppMergeTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        let store = try ClipStore.make(directory: directory)
        try await store.prepare()
        return store
    }

    private func text(_ string: String) -> ClipDraft {
        ClipDraft(
            kind: .text, preview: string, fullText: string, characterCount: string.count,
            sourceAppBundleID: "com.apple.Notes", sourceAppName: "Notes",
            byteSize: string.utf8.count, contentHash: "text:" + string,
            payload: ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(string.utf8))]])
        )
    }

    private func history(_ store: ClipStore) async throws -> [ClipItem] {
        try await store.page(ClipQuery(scope: .history), after: nil, limit: 100).items
    }

    private func pinboard(_ store: ClipStore, _ id: UUID) async throws -> [ClipItem] {
        try await store.page(ClipQuery(scope: .pinboard(id)), after: nil, limit: 100).items
    }

    private func search(_ store: ClipStore, _ needle: String) async throws -> [UUID] {
        try await store.page(ClipQuery(scope: .history, searchText: needle), after: nil, limit: 100).items.map(\.id)
    }

    // MARK: - 用例

    @Test func examplePinboardsFromTwoMacsMergeIntoOne() async throws {
        let store = try await makeStore()
        let id = UUID()
        _ = try await store.createPinboard(id: id, name: "Snippets", color: .blue)
        try await store.markAsExamples(clipIDs: [], pinboardIDs: [id])
        // 另一台 Mac 晚一些装的同一份示例 Pinboard，用户在那边改了名
        try await store.insertRemotePinboard(id: id, name: "Templates", createdAt: .now.addingTimeInterval(60), isExample: false)
        #expect(try await store.pinboards().count == 1)

        #expect(try await store.mergeCloudChanges())
        let pinboards = try await store.pinboards()
        #expect(pinboards.map(\.name) == ["Templates"])
        #expect(try await store.hasUntouchedExamples() == false)
        // 跑几遍都一样
        #expect(try await store.mergeCloudChanges() == false)
    }

    @Test func sameContentPinnedOnTwoMacsBecomesOneCard() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let local = try await store.ingest(text("hello world"))
        _ = try await store.pin(local.id, to: board.id)
        // 另一台 Mac 更早收进同一内容，还起了标题
        let remoteID = UUID()
        try await store.insertRemotePinned(id: remoteID, text: "hello world", pinboardID: board.id, createdAt: .now.addingTimeInterval(-3600), title: "Greeting")

        #expect(try await store.mergeCloudChanges())
        let pinned = try await pinboard(store, board.id)
        #expect(pinned.map(\.id) == [remoteID])
        #expect(pinned.first?.title == "Greeting")
        // 本机 History 换成副本的 uuid，合成一张卡
        let first = try #require(try await history(store).first)
        #expect(first.id == remoteID)
        #expect(first.title == "Greeting")
        #expect(first.pinboardID == board.id)
        #expect(try await search(store, "hello") == [remoteID])
        #expect(try await search(store, "greeting") == [remoteID])
        #expect(try await store.mergeCloudChanges() == false)
    }

    @Test func remoteRenameReachesHistoryAndSearch() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let item = try await store.ingest(text("alpha beta gamma"))
        _ = try await store.pin(item.id, to: board.id)
        _ = try await store.mergeCloudChanges()

        try await store.updateRemotePinned(id: item.id, title: "Renamed elsewhere")
        #expect(try await store.mergeCloudChanges())
        #expect(try await history(store).first?.title == "Renamed elsewhere")
        #expect(try await search(store, "elsewhere") == [item.id])
    }

    @Test func remoteRemovalLeavesSearch() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let item = try await store.ingest(text("only in the pinboard"))
        _ = try await store.pin(item.id, to: board.id)
        // 从 History 删掉并物理清除：只剩 Pinboard 里的副本
        _ = try await store.remove(item.id, from: .history)
        try await store.purgeTrash(olderThan: .now.addingTimeInterval(1))
        _ = try await store.mergeCloudChanges()
        #expect(try await search(store, "pinboard") == [item.id])

        // 另一台 Mac 把它从 Pinboard 删了
        try await store.updateRemotePinned(id: item.id, trashed: true)
        #expect(try await store.mergeCloudChanges())
        #expect(try await search(store, "pinboard").isEmpty)
        #expect(try await pinboard(store, board.id).isEmpty)
    }

    @Test func identicalCopiesAreKeptButShownOnceAndRemovedTogether() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let id = UUID()
        let date = Date.now.addingTimeInterval(-60)
        // 完全相同、比不出先后的两份：不删（免得两台 Mac 各删一份），只显示一张
        try await store.insertRemotePinned(id: id, text: "twin", pinboardID: board.id, createdAt: date)
        try await store.insertRemotePinned(id: id, text: "twin", pinboardID: board.id, createdAt: date)
        _ = try await store.mergeCloudChanges()
        #expect(try await pinboard(store, board.id).map(\.id) == [id])
        #expect(try await search(store, "twin") == [id])

        // 删一次就两份都删（只删一份的话，重读时另一份又出现）
        let removal = try await store.remove(id, from: .pinboard)
        #expect(try await pinboard(store, board.id).isEmpty)
        #expect(try await search(store, "twin").isEmpty)
        #expect(try await store.copies(of: id).allSatisfy { $0.trashed })
        // ⌘Z 两份一起回来
        _ = try await store.undo(removal)
        #expect(try await pinboard(store, board.id).map(\.id) == [id])
        #expect(try await store.copies(of: id).allSatisfy { !$0.trashed })
    }

    @Test func twinWritesApplyToEveryCopy() async throws {
        let store = try await makeStore()
        let work = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let home = try await store.createPinboard(id: UUID(), name: "Home", color: .green)
        let id = UUID()
        let date = Date.now.addingTimeInterval(-60)
        try await store.insertRemotePinned(id: id, text: "twin note", pinboardID: work.id, createdAt: date, title: "Zebra")
        try await store.insertRemotePinned(id: id, text: "twin note", pinboardID: work.id, createdAt: date, title: "Zebra")

        // 改名：两份都改，合并不会按标题比出先后、把改名冲回去
        _ = try await store.rename(id, to: "Apple")
        #expect(try await store.copies(of: id).map(\.title) == ["Apple", "Apple"])
        _ = try await store.mergeCloudChanges()
        #expect(try await pinboard(store, work.id).first?.title == "Apple")

        // 移到另一个 Pinboard：两份一起挪
        _ = try await store.pin(id, to: home.id)
        #expect(try await store.copies(of: id).allSatisfy { $0.pinboardID == home.id })
        #expect(try await pinboard(store, work.id).isEmpty)
        #expect(try await pinboard(store, home.id).map(\.id) == [id])

        // 移出：两份一起删
        _ = try await store.pin(id, to: nil)
        #expect(try await store.copies(of: id).isEmpty)
    }

    @Test func twinPinboardRecordsAreChangedTogether() async throws {
        let store = try await makeStore()
        let first = try await store.createPinboard(id: UUID(), name: "A", color: .red)
        let twin = try await store.createPinboard(id: UUID(), name: "B", color: .green)
        _ = try await store.createPinboard(id: UUID(), name: "C", color: .blue)
        // 别的 Mac 同步来一份完全相同的 B（比不出先后，合并不删）
        try await store.duplicatePinboardRecord(twin.id)
        _ = try await store.mergeCloudChanges()
        #expect(try await store.pinboards().map(\.name) == ["A", "B", "C"])

        try await store.movePinboard(twin.id, by: -1)
        #expect(try await store.pinboards().map(\.name) == ["B", "A", "C"])
        try await store.updatePinboard(Pinboard(id: twin.id, name: "Renamed", color: .pink, sortKey: 0))
        #expect(try await store.pinboardRecordNames(twin.id) == ["Renamed", "Renamed"])

        try await store.deletePinboard(twin.id)
        #expect(try await store.pinboards().map(\.name) == ["A", "C"])
        #expect(try await store.pinboardRecordNames(twin.id).isEmpty)
        _ = first
    }

    @Test func renamedExampleOnSecondMacSurvivesMerge() async throws {
        let store = try await makeStore()
        let snippets = UUID()
        _ = try await store.createPinboard(id: snippets, name: "Snippets", color: .blue)
        // 这台（后装的）Mac：示例装好后用户改了名
        let local = try await store.ingest(text("Out of office"))
        _ = try await store.rename(local.id, to: "Out of office")
        _ = try await store.pin(local.id, to: snippets)
        try await store.markAsExamples(clipIDs: [local.id], pinboardIDs: [snippets])
        _ = try await store.rename(local.id, to: "OOO")
        // 先装的那台 Mac 的同一份示例（更早创建、没动过）同步过来
        let remoteID = UUID()
        try await store.insertRemotePinned(id: remoteID, text: "Out of office", pinboardID: snippets, createdAt: .now.addingTimeInterval(-86400), title: "Out of office", isExample: true)

        #expect(try await store.mergeCloudChanges())
        let pinned = try await pinboard(store, snippets)
        #expect(pinned.map(\.id) == [remoteID])
        #expect(pinned.first?.title == "OOO")
        #expect(try await history(store).first?.title == "OOO")
        #expect(try await store.hasUntouchedExamples() == false)
    }

    @Test func keeperChoiceIgnoresSubSecondDifferences() async throws {
        // 两台 Mac 看到的日期精度不同（同步来的只到毫秒）：比到秒以下会各选各的保留者、两份都删。按整秒比，同一秒交给 uuid
        let small = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let large = UUID(uuidString: "FFFFFFFF-0000-0000-0000-000000000001")!
        let second = Date(timeIntervalSince1970: (Date.now.timeIntervalSince1970 - 600).rounded(.down) + 0.5)
        for largeIsEarlier in [true, false] {
            let store = try await makeStore()
            let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
            let offset = largeIsEarlier ? -0.0004 : 0.0004
            try await store.insertRemotePinned(id: small, text: "same text", pinboardID: board.id, createdAt: second)
            try await store.insertRemotePinned(id: large, text: "same text", pinboardID: board.id, createdAt: second.addingTimeInterval(offset))
            _ = try await store.mergeCloudChanges()
            #expect(try await pinboard(store, board.id).map(\.id) == [small])
        }
    }

    @Test func copyingAndUsingDoNotWritePinnedRows() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let item = try await store.ingest(text("quiet cloud row"))
        _ = try await store.pin(item.id, to: board.id)
        let before = try await store.copies(of: item.id).map(\.lastUsedAt)
        _ = try await store.ingest(text("quiet cloud row"))
        _ = try await store.markUsed(item.id)
        #expect(try await store.copies(of: item.id).map(\.lastUsedAt) == before)
        // History 照样移到最前
        #expect(try await history(store).first?.id == item.id)
    }

    @Test func usingPinnedOnlyItemReusesSameContentHistoryRow() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let local = try await store.ingest(text("shared snippet"))
        // 别的 Mac 收进的同一内容，还没合并（uuid 没对上）
        let remoteID = UUID()
        try await store.insertRemotePinned(id: remoteID, text: "shared snippet", pinboardID: board.id, createdAt: .now.addingTimeInterval(-3600))
        let used = try await store.markUsed(remoteID)
        #expect(used.id == remoteID)
        let items = try await history(store)
        #expect(items.map(\.id) == [remoteID])
        #expect(items.first?.pinboardID == board.id)
        #expect(try await search(store, "shared") == [remoteID])
        _ = local
    }

    @Test func pinboardsWithEqualSortKeysAreOrderedAndMovable() async throws {
        let store = try await makeStore()
        let a = try await store.createPinboard(id: UUID(uuidString: "AAAAAAAA-0000-0000-0000-000000000000")!, name: "A", color: .red)
        let b = try await store.createPinboard(id: UUID(uuidString: "BBBBBBBB-0000-0000-0000-000000000000")!, name: "B", color: .green)
        let c = try await store.createPinboard(id: UUID(uuidString: "CCCCCCCC-0000-0000-0000-000000000000")!, name: "C", color: .blue)
        // 两台 Mac 各自建的：排序键撞在一起（同步来、合并之后）
        try await store.setSortKey(1, for: [a.id, b.id, c.id])
        _ = try await store.mergeCloudChanges()
        #expect(try await store.pinboards().map(\.name) == ["A", "B", "C"])
        try await store.movePinboard(a.id, by: 1)
        #expect(try await store.pinboards().map(\.name) == ["B", "A", "C"])
        try await store.movePinboard(c.id, by: -2)
        #expect(try await store.pinboards().map(\.name) == ["C", "B", "A"])
    }

    @Test func pinnedTrashKeepsGracePeriodAtLaunch() async throws {
        let store = try await makeStore()
        let board = try await store.createPinboard(id: UUID(), name: "Work", color: .orange)
        let item = try await store.ingest(text("deleted on another mac"))
        _ = try await store.pin(item.id, to: board.id)
        let removal = try await store.remove(item.id, from: .pinboard)
        // 启动时的清理（olderThan: .now）不动刚删的副本：它可能是别的 Mac 刚删、对方还要 ⌘Z
        try await store.purgeTrash(olderThan: .now)
        #expect(try await store.copies(of: item.id).count == 1)
        _ = try await store.undo(removal)
        #expect(try await pinboard(store, board.id).map(\.id) == [item.id])
        // 删了超过一小时的才物理删除
        _ = try await store.remove(item.id, from: .pinboard)
        try await store.backdateTrash(of: item.id, by: 7200)
        try await store.purgeTrash(olderThan: .now)
        #expect(try await store.copies(of: item.id).isEmpty)
    }
}

// MARK: - 模拟别的 Mac 同步来的记录

extension ClipStore {
    func insertRemotePinboard(id: UUID, name: String, createdAt: Date, isExample: Bool) throws {
        let record = PinboardRecord()
        record.uuid = id
        record.name = name
        record.createdAt = createdAt
        record.isExample = isExample
        record.sortKey = 99
        cloud.insert(record)
        try cloud.save()
    }

    func insertRemotePinned(id: UUID, text: String, pinboardID: UUID, createdAt: Date, title: String? = nil, isExample: Bool = false) throws {
        let copy = PinnedClip()
        copy.uuid = id
        copy.createdAt = createdAt
        copy.lastUsedAt = createdAt
        copy.kindRaw = ClipKind.text.rawValue
        copy.title = title
        copy.isExample = isExample
        copy.preview = text
        copy.characterCount = text.count
        copy.byteSize = text.utf8.count
        copy.contentHash = "text:" + text
        copy.searchText = SearchFolding.fold(text)
        copy.pinboardID = pinboardID
        cloud.insert(copy)
        let archive = try PropertyListEncoder().encode(ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(text.utf8))]]))
        let payload = PinnedPayload(archive: archive)
        cloud.insert(payload)
        copy.payload = payload
        try cloud.save()
    }

    func updateRemotePinned(id: UUID, title: String? = nil, trashed: Bool = false) throws {
        let matches = try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.uuid == id }))
        for copy in matches {
            if let title { copy.title = title }
            if trashed { copy.trashedAt = .now }
        }
        try cloud.save()
    }

    /// 同 uuid 的全部副本（含软删除的）
    func copies(of id: UUID) throws -> [(title: String?, pinboardID: UUID?, lastUsedAt: Date, trashed: Bool)] {
        try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.uuid == id }))
            .map { ($0.title, $0.pinboardID, $0.lastUsedAt, $0.trashedAt != nil) }
    }

    /// 别的 Mac 同步来一份完全相同的 Pinboard 记录
    func duplicatePinboardRecord(_ id: UUID) throws {
        guard let source = try cloud.fetch(FetchDescriptor<PinboardRecord>(predicate: #Predicate { $0.uuid == id })).first else { return }
        let record = PinboardRecord()
        record.uuid = source.uuid
        record.name = source.name
        record.colorRaw = source.colorRaw
        record.sortKey = source.sortKey
        record.createdAt = source.createdAt
        record.isExample = source.isExample
        cloud.insert(record)
        try cloud.save()
    }

    func pinboardRecordNames(_ id: UUID) throws -> [String] {
        try cloud.fetch(FetchDescriptor<PinboardRecord>(predicate: #Predicate { $0.uuid == id })).map(\.name)
    }

    func setSortKey(_ key: Double, for ids: [UUID]) throws {
        for record in try cloud.fetch(FetchDescriptor<PinboardRecord>()) where ids.contains(record.uuid) {
            record.sortKey = key
        }
        try cloud.save()
    }

    func backdateTrash(of id: UUID, by seconds: TimeInterval) throws {
        for copy in try cloud.fetch(FetchDescriptor<PinnedClip>(predicate: #Predicate { $0.uuid == id })) {
            copy.trashedAt = copy.trashedAt?.addingTimeInterval(-seconds)
        }
        try cloud.save()
    }
}
