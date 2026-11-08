//
//  ClipStoreTests.swift
//  ClipDataTests
//
//  数据层的行为测试：每个用例开一个临时目录里的真实 SQLite 库（ 约束 4：谓词用真实库测，不只用内存库）。
//

import Foundation
import Testing
@testable import ClipData

@Suite struct ClipStoreTests {

    // MARK: - 工具

    private func makeRepository() -> (SwiftDataClipRepository, URL) {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ClipDataTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        return (SwiftDataClipRepository(directory: directory), directory)
    }

    private func text(_ string: String, app: String = "com.apple.Notes") -> ClipDraft {
        ClipDraft(
            kind: .text, preview: String(string.prefix(600)), fullText: string, characterCount: string.count,
            sourceAppBundleID: app, sourceAppName: "Notes",
            byteSize: string.utf8.count, contentHash: "text:" + string,
            payload: ClipPayload(items: [[ClipRepresentation(type: "public.utf8-plain-text", data: Data(string.utf8))]])
        )
    }

    private func history(_ repository: SwiftDataClipRepository, limit: Int = 100) async throws -> [ClipItem] {
        try await repository.page(ClipQuery(scope: .history), after: nil, limit: limit).items
    }

    private func search(_ repository: SwiftDataClipRepository, _ needle: String) async throws -> [ClipItem] {
        try await repository.page(ClipQuery(scope: .history, searchText: needle), after: nil, limit: 100).items
    }

    // MARK: - 采集与列表

    @Test func newestFirstAndDedupeMovesToFront() async throws {
        let (repository, _) = makeRepository()
        _ = try await repository.ingest(text("first"))
        _ = try await repository.ingest(text("second"))
        _ = try await repository.ingest(text("third"))
        #expect(try await history(repository).map(\.preview) == ["third", "second", "first"])

        // C3：重复复制不新增，原条目移到最前
        let again = try await repository.ingest(text("first"))
        let items = try await history(repository)
        #expect(items.map(\.preview) == ["first", "third", "second"])
        #expect(items.first?.id == again.id)
        #expect(items.count == 3)
    }

    @Test func keysetPagination() async throws {
        let (repository, _) = makeRepository()
        for index in 1...5 { _ = try await repository.ingest(text("item \(index)")) }
        let first = try await repository.page(ClipQuery(scope: .history), after: nil, limit: 2)
        #expect(first.items.map(\.preview) == ["item 5", "item 4"])
        let second = try await repository.page(ClipQuery(scope: .history), after: first.nextCursor, limit: 2)
        #expect(second.items.map(\.preview) == ["item 3", "item 2"])
        let third = try await repository.page(ClipQuery(scope: .history), after: second.nextCursor, limit: 2)
        #expect(third.items.map(\.preview) == ["item 1"])
        #expect(third.nextCursor == nil)
    }

    @Test func payloadAndThumbnailRoundTrip() async throws {
        let (repository, _) = makeRepository()
        var draft = text("hello")
        draft.thumbnail = Data([1, 2, 3])
        let item = try await repository.ingest(draft)
        let payload = try await repository.payload(for: item.id)
        #expect(payload.items.first?.first?.data == Data("hello".utf8))
        #expect(await repository.thumbnail(for: item.id) == Data([1, 2, 3]))
    }

    // MARK: - Pinboard（B5）

    @Test func pinKeepsHistoryAndShowsInPinboard() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Work", color: .orange)
        let item = try await repository.ingest(text("standup notes"))
        let pinned = try await repository.pin(item.id, to: board.id)
        #expect(pinned?.pinboardID == board.id)
        #expect(pinned?.isInHistory == true)

        let inHistory = try await history(repository)
        #expect(inHistory.first?.pinboardID == board.id)
        let inBoard = try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items
        #expect(inBoard.map(\.id) == [item.id])

        // 移出 Pinboard：History 里还在
        let unpinned = try await repository.pin(item.id, to: nil)
        #expect(unpinned?.pinboardID == nil)
        #expect(try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items.isEmpty)
        #expect(try await history(repository).count == 1)
    }

    @Test func removalsAreIndependentAndUndoable() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Snippets", color: .blue)
        let item = try await repository.ingest(text("Best regards"))
        _ = try await repository.pin(item.id, to: board.id)

        // 在 History 删除不影响 Pinboard
        let removal = try await repository.remove(item.id, from: .history)
        #expect(try await history(repository).isEmpty)
        #expect(try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items.count == 1)

        // ⌘Z 恢复
        let restored = try await repository.undo(removal)
        #expect(restored.isInHistory)
        #expect(restored.pinboardID == board.id)

        // 搜索结果里删除 = 两边都删，也能撤销
        let everywhere = try await repository.remove(item.id, from: .everywhere)
        #expect(try await history(repository).isEmpty)
        #expect(try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items.isEmpty)
        #expect(try await search(repository, "regards").isEmpty)
        _ = try await repository.undo(everywhere)
        #expect(try await search(repository, "regards").count == 1)
    }

    @Test func copyingPinnedContentAgainMergesIntoOneCard() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Snippets", color: .blue)
        let item = try await repository.ingest(text("my address"))
        _ = try await repository.pin(item.id, to: board.id)
        _ = try await repository.remove(item.id, from: .history)
        try await repository.purgeTrash(olderThan: .distantFuture)

        // 只在 Pinboard 里了；再复制一次同样内容，History 里出现的仍是同一张卡
        let again = try await repository.ingest(text("my address"))
        #expect(again.id == item.id)
        #expect(again.pinboardID == board.id)
        #expect(try await search(repository, "address").count == 1)
    }

    @Test func deletingPinboardKeepsClipsThatAreInHistory() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Links", color: .orange)
        let kept = try await repository.ingest(text("kept in history"))
        let pinnedOnly = try await repository.ingest(text("only pinned"))
        _ = try await repository.pin(kept.id, to: board.id)
        _ = try await repository.pin(pinnedOnly.id, to: board.id)
        _ = try await repository.remove(pinnedOnly.id, from: .history)

        try await repository.deletePinboard(board.id)
        #expect(try await repository.pinboards().isEmpty)
        let items = try await history(repository)
        #expect(items.map(\.preview) == ["kept in history"])
        #expect(items.first?.pinboardID == nil)
        #expect(try await search(repository, "only pinned").isEmpty)
    }

    @Test func eraseHistoryKeepsPinboards() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Keep", color: .green)
        let pinned = try await repository.ingest(text("pinned forever"))
        _ = try await repository.ingest(text("just history"))
        _ = try await repository.pin(pinned.id, to: board.id)

        try await repository.eraseHistory(before: nil)
        #expect(try await history(repository).isEmpty)
        #expect(try await repository.historyCount(before: nil) == 0)
        let inBoard = try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items
        #expect(inBoard.map(\.preview) == ["pinned forever"])
        #expect(try await search(repository, "forever").count == 1)
        #expect(try await search(repository, "just").isEmpty)
    }

    @Test func movePinboardChangesOnlyOrder() async throws {
        let (repository, _) = makeRepository()
        let a = try await repository.createPinboard(name: "A", color: .red)
        _ = try await repository.createPinboard(name: "B", color: .green)
        _ = try await repository.createPinboard(name: "C", color: .blue)
        try await repository.movePinboard(a.id, by: 2)
        #expect(try await repository.pinboards().map(\.name) == ["B", "C", "A"])
    }

    // MARK: - 搜索（F3）

    @Test func substringSearchIgnoresCaseAndDiacritics() async throws {
        let (repository, _) = makeRepository()
        _ = try await repository.ingest(text("Café au lait, crème brûlée"))
        _ = try await repository.ingest(text("support@northwind.co"))
        _ = try await repository.ingest(text("Résumé review at 10"))

        #expect(try await search(repository, "creme").map(\.preview) == ["Café au lait, crème brûlée"])
        #expect(try await search(repository, "CAFE").count == 1)
        #expect(try await search(repository, "northwind.c").count == 1)
        #expect(try await search(repository, "resume").count == 1)
        // 1–2 个字符
        #expect(try await search(repository, "10").count == 1)
        #expect(try await search(repository, "é").count == 2)
        #expect(try await search(repository, "zzz").isEmpty)
    }

    @Test func renamedTitleIsSearchable() async throws {
        let (repository, _) = makeRepository()
        let item = try await repository.ingest(text("xcrun simctl list devices booted"))
        _ = try await repository.rename(item.id, to: "Simulator list")
        #expect(try await search(repository, "simulator").map(\.id) == [item.id])
        #expect(try await history(repository).first?.title == "Simulator list")
    }

    @Test func searchPagesNewestFirst() async throws {
        let (repository, _) = makeRepository()
        for index in 1...5 { _ = try await repository.ingest(text("note \(index)")) }
        let query = ClipQuery(scope: .history, searchText: "note")
        let first = try await repository.page(query, after: nil, limit: 3)
        #expect(first.items.map(\.preview) == ["note 5", "note 4", "note 3"])
        let second = try await repository.page(query, after: first.nextCursor, limit: 3)
        #expect(second.items.map(\.preview) == ["note 2", "note 1"])
    }

    @Test func searchCursorSurvivesAnchorDeletedOrUsed() async throws {
        let (repository, _) = makeRepository()
        for index in 1...9 { _ = try await repository.ingest(text("note \(index)")) }
        let query = ClipQuery(scope: .history, searchText: "note")
        let first = try await repository.page(query, after: nil, limit: 3)
        let second = try await repository.page(query, after: first.nextCursor, limit: 3)
        #expect(second.items.map(\.preview) == ["note 6", "note 5", "note 4"])
        // 锚点（上一页最后一条）被删掉：下一页照常接着往后，不从头再来
        _ = try await repository.remove(second.items[2].id, from: .everywhere)
        let third = try await repository.page(query, after: second.nextCursor, limit: 3)
        #expect(third.items.map(\.preview) == ["note 3", "note 2", "note 1"])
        // 锚点被取用（移到最前）：下一页也不回到开头
        _ = try await repository.markUsed(first.items[2].id)
        let again = try await repository.page(query, after: first.nextCursor, limit: 3)
        #expect(again.items.map(\.preview) == ["note 6", "note 5", "note 3"])
    }

    // MARK: - 清空历史（分批）

    @Test func batchedEraseKeepsPinboardsAndIndexConsistent() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Keep", color: .green)
        var pinnedIDs: [UUID] = []
        var cutoff = Date.distantPast
        for index in 0..<1_100 {
            let item = try await repository.ingest(text("bulk entry \(index)"))
            if index % 250 == 0 {
                _ = try await repository.pin(item.id, to: board.id)
                pinnedIDs.append(item.id)
            }
            if index == 599 { cutoff = item.lastUsedAt.addingTimeInterval(0.0005) }
        }
        // 按保存时长清掉较早的 600 条（跨两批）
        try await repository.eraseHistory(before: cutoff)
        #expect(try await repository.historyCount(before: nil) == 500)
        // 清空全部：Pinboard 里的留着、仍搜得到；索引与数据对得上
        try await repository.eraseHistory(before: nil)
        #expect(try await repository.historyCount(before: nil) == 0)
        #expect(try await history(repository).isEmpty)
        let inBoard = try await repository.page(ClipQuery(scope: .pinboard(board.id)), after: nil, limit: 100).items
        #expect(Set(inBoard.map(\.id)) == Set(pinnedIDs))
        #expect(Set(try await search(repository, "bulk entry").map(\.id)) == Set(pinnedIDs))
        #expect(try await repository.currentStore().indexNeedsRepair() == false)
    }

    // MARK: - 示例内容（G5）

    @Test func clearExamplesKeepsTouchedOnesAndRemovesEmptyBoards() async throws {
        let (repository, _) = makeRepository()
        let board = try await repository.createPinboard(name: "Snippets", color: .blue)
        let untouched = try await repository.ingest(text("example one"))
        let renamed = try await repository.ingest(text("example two"))
        let inBoard = try await repository.ingest(text("example three"))
        _ = try await repository.pin(inBoard.id, to: board.id)
        try await repository.markAsExamples(clipIDs: [untouched.id, renamed.id, inBoard.id], pinboardIDs: [board.id])
        #expect(await repository.hasUntouchedExamples())

        _ = try await repository.rename(renamed.id, to: "Mine now")
        try await repository.removeUntouchedExamples()

        #expect(try await history(repository).map(\.id) == [renamed.id])
        #expect(try await repository.pinboards().isEmpty)
        #expect(await repository.hasUntouchedExamples() == false)
    }

    // MARK: - 持久化

    @Test func dataSurvivesReopening() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "ClipDataTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        do {
            let repository = SwiftDataClipRepository(directory: directory)
            let board = try await repository.createPinboard(name: "Saved", color: .purple)
            let item = try await repository.ingest(text("persist me"))
            _ = try await repository.pin(item.id, to: board.id)
        }
        let reopened = SwiftDataClipRepository(directory: directory)
        #expect(try await reopened.pinboards().map(\.name) == ["Saved"])
        #expect(try await reopened.page(ClipQuery(scope: .history), after: nil, limit: 10).items.map(\.preview) == ["persist me"])
        #expect(try await reopened.page(ClipQuery(scope: .history, searchText: "persist"), after: nil, limit: 10).items.count == 1)
    }

    @Test func missingFileIsDetected() async throws {
        let (repository, directory) = makeRepository()
        let file = directory.appending(path: "Report.pdf")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("pdf".utf8).write(to: file)
        let path = file.path(percentEncoded: false)
        let draft = ClipDraft(
            kind: .file, preview: "Report.pdf", fullText: path, characterCount: 0,
            fileNames: ["Report.pdf"], filePaths: [path],
            byteSize: 3, contentHash: "file:" + path,
            payload: ClipPayload(items: [[ClipRepresentation(type: "public.file-url", data: Data(file.absoluteString.utf8))]])
        )
        let item = try await repository.ingest(draft)
        #expect(item.isFileMissing == false)
        try FileManager.default.removeItem(at: file)
        #expect(try await history(repository).first?.isFileMissing == true)
    }
}
