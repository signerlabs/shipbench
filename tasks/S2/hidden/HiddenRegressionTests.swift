//
//  HiddenRegressionTests.swift
//  ClipDataTests
//
//  判分用的隐藏测试（不给工具看）：搜索翻页的锚点被删、被取用；Pinboard 排序键撞在一起时的顺序与拖动。
//  只用自己的工具函数（名字都带 hidden 前缀），不依赖其他测试文件里的私有工具，免得和工具新写的测试撞名。
//

import Foundation
import SwiftData
import Testing
@testable import ClipData

@Suite struct HiddenRegressionTests {

    private func hiddenRepository() -> SwiftDataClipRepository {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ClipDataHidden-\(UUID().uuidString)", directoryHint: .isDirectory)
        return SwiftDataClipRepository(directory: directory)
    }

    private func hiddenStore() async throws -> ClipStore {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ClipDataHiddenStore-\(UUID().uuidString)", directoryHint: .isDirectory)
        let store = try ClipStore.make(directory: directory)
        try await store.prepare()
        return store
    }

    private func hiddenText(_ string: String) -> ClipDraft {
        ClipDraft(
            kind: .text, preview: string, fullText: string, characterCount: string.count,
            sourceAppBundleID: "com.apple.Notes", sourceAppName: "Notes",
            byteSize: string.utf8.count, contentHash: "text:" + string,
            payload: ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(string.utf8))]])
        )
    }

    private func hiddenNotes(_ repository: SwiftDataClipRepository, count: Int = 9) async throws {
        for index in 1...count { _ = try await repository.ingest(hiddenText("note \(index)")) }
    }

    // MARK: - 搜索翻页：锚点（上一页最后一条）被删、被取用

    /// 3 个字以上的搜索词（全文索引那条路）：锚点被删后，下一页接着往后
    @Test(arguments: ["note", "no"])
    func hiddenSearchAnchorDeleted(_ needle: String) async throws {
        let repository = hiddenRepository()
        try await hiddenNotes(repository)
        let query = ClipQuery(scope: .history, searchText: needle)
        let first = try await repository.page(query, after: nil, limit: 3)
        let second = try await repository.page(query, after: first.nextCursor, limit: 3)
        #expect(second.items.map(\.preview) == ["note 6", "note 5", "note 4"])
        _ = try await repository.remove(second.items[2].id, from: .everywhere)
        let third = try await repository.page(query, after: second.nextCursor, limit: 3)
        #expect(third.items.map(\.preview) == ["note 3", "note 2", "note 1"])
    }

    /// 锚点被取用（移到最前）：下一页不回到开头
    @Test(arguments: ["note", "ot"])
    func hiddenSearchAnchorUsed(_ needle: String) async throws {
        let repository = hiddenRepository()
        try await hiddenNotes(repository)
        let query = ClipQuery(scope: .history, searchText: needle)
        let first = try await repository.page(query, after: nil, limit: 3)
        #expect(first.items.map(\.preview) == ["note 9", "note 8", "note 7"])
        _ = try await repository.markUsed(first.items[2].id)
        let next = try await repository.page(query, after: first.nextCursor, limit: 3)
        #expect(next.items.map(\.preview) == ["note 6", "note 5", "note 4"])
    }

    /// 一页页翻到底，每翻一页就把锚点取用一次、或删掉一次：不重复、不遗漏、能翻完
    @Test(arguments: [false, true])
    func hiddenSearchFullScanWhileChanging(_ deleteAnchor: Bool) async throws {
        let repository = hiddenRepository()
        for index in 1...20 { _ = try await repository.ingest(hiddenText(String(format: "item %02d", index))) }
        let query = ClipQuery(scope: .history, searchText: "item")
        var seen: [String] = []
        var cursor: ClipCursor?
        for _ in 0..<12 {
            let page = try await repository.page(query, after: cursor, limit: 4)
            seen += page.items.map(\.preview)
            guard let next = page.nextCursor, let anchor = page.items.last else { break }
            if deleteAnchor {
                _ = try await repository.remove(anchor.id, from: .everywhere)
            } else {
                _ = try await repository.markUsed(anchor.id)
            }
            cursor = next
        }
        #expect(seen == (1...20).reversed().map { String(format: "item %02d", $0) })
    }

    // MARK: - Pinboard 排序键撞在一起（两台 Mac 各建、同步合并后）

    @Test func hiddenEqualSortKeysOrderedAndMovable() async throws {
        let store = try await hiddenStore()
        let a = try await store.createPinboard(id: UUID(uuidString: "AAAAAAAA-0000-0000-0000-000000000000")!, name: "A", color: .red)
        let b = try await store.createPinboard(id: UUID(uuidString: "BBBBBBBB-0000-0000-0000-000000000000")!, name: "B", color: .green)
        let c = try await store.createPinboard(id: UUID(uuidString: "CCCCCCCC-0000-0000-0000-000000000000")!, name: "C", color: .blue)
        try await store.hiddenSetSortKey(1, for: [a.id, b.id, c.id])
        _ = try await store.mergeCloudChanges()
        #expect(try await store.pinboards().map(\.name) == ["A", "B", "C"])
        try await store.movePinboard(a.id, by: 1)
        #expect(try await store.pinboards().map(\.name) == ["B", "A", "C"])
        try await store.movePinboard(c.id, by: -2)
        #expect(try await store.pinboards().map(\.name) == ["C", "B", "A"])
    }

    /// 四个排序键全相同：跨两格、跨三格地拖，每次都到位
    @Test func hiddenEqualSortKeysFourBoardsMoveFar() async throws {
        let store = try await hiddenStore()
        var ids: [String: UUID] = [:]
        for (letter, hex) in [("A", "A1"), ("B", "B2"), ("C", "C3"), ("D", "D4")] {
            let board = try await store.createPinboard(id: UUID(uuidString: "\(hex)\(hex)\(hex)\(hex)-0000-0000-0000-000000000000")!, name: letter, color: .orange)
            ids[letter] = board.id
        }
        try await store.hiddenSetSortKey(0, for: Array(ids.values))
        _ = try await store.mergeCloudChanges()
        #expect(try await store.pinboards().map(\.name) == ["A", "B", "C", "D"])
        try await store.movePinboard(ids["A"]!, by: 2)
        #expect(try await store.pinboards().map(\.name) == ["B", "C", "A", "D"])
        try await store.movePinboard(ids["D"]!, by: -3)
        #expect(try await store.pinboards().map(\.name) == ["D", "B", "C", "A"])
        try await store.movePinboard(ids["B"]!, by: 1)
        #expect(try await store.pinboards().map(\.name) == ["D", "C", "B", "A"])
    }
}

extension ClipStore {
    /// 模拟两台 Mac 各自建的 Pinboard 同步过来：排序键撞在一起
    func hiddenSetSortKey(_ key: Double, for ids: [UUID]) throws {
        for record in try cloud.fetch(FetchDescriptor<PinboardRecord>()) where ids.contains(record.uuid) {
            record.sortKey = key
        }
        try cloud.save()
    }
}
