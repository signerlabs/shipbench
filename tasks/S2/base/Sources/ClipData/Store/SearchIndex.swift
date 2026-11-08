//
//  SearchIndex.swift
//  ClipData
//
//  搜索旁路索引：SQLite FTS5 + trigram 分词。派生数据，不同步、可随时从 SwiftData 重建。
//  - rowid 用条目的"最近使用时间（毫秒）"：结果天然新的在前，按它做 keyset 翻页
//  - 3 个字符以上走 trigram 索引（短语 MATCH）；1–2 个字符走 LIKE 扫描（实测比 instr、mmap 都快，10 万条无命中约 90 ms）
//  - 存的与查的都是 SearchFolding 折叠后的文本（不分大小写与变音符），不依赖 SQLite 的折叠
//  - pinned_state 记着上次核对时每个 Pinboard 副本的"指纹"：iCloud 收到改动后只重写变过的行
//  - meta 记着"待修补"：写索引失败或修补到一半退出，下次启动接着在后台修补
//  - orphan_seen 记着同步库里的孤儿行第一次被看到的时间（ClipStore.sweepOrphans：连续 24 小时都是孤儿才处理）
//  文件打不开、格式不对就删掉重建（用户 2026-10-10 定：索引坏了静默重建），再不行退到内存库。
//  只在 ClipStore 这个 actor 里使用，不跨线程。
//

import Foundation
import SQLite3

final class SearchIndex {

    enum IndexError: Error {
        case sqlite(String)
    }

    /// 一条索引行：rank = 最近使用时间（毫秒），body = 折叠后的"标题 + 内容"
    struct Entry {
        let rank: Int64
        let body: String
    }

    private var db: OpaquePointer?
    /// nil = 内存库（文件实在打不开时的退路）
    private let url: URL?
    /// 打开时发现文件坏了、已删掉重建（或退到内存库）：调用方要安排一次全量修补
    var wasReset = false
    /// 上次写索引失败或修补没做完（存在 meta 里，跨启动保留）
    private(set) var needsRepair = false

    /// 表结构版本（PRAGMA user_version）：0 = 早期没有 meta 表的版本，原地补建即可
    private static let schemaVersion: Int32 = 1
    private static let needsRepairKey = "needsRepair"

    /// SQLite 绑定文本时让它自己拷一份
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// 打开索引：打不开或格式不对就删掉文件重建；还不行退到内存库（本次运行搜索照常，下次启动再试文件）
    static func open(url: URL) throws -> SearchIndex {
        if let index = try? SearchIndex(url: url) { return index }
        removeFiles(at: url)
        if let index = try? SearchIndex(url: url) {
            index.wasReset = true
            return index
        }
        let index = try SearchIndex(url: nil)
        index.wasReset = true
        return index
    }

    init(url: URL?) throws {
        self.url = url
        try connect()
    }

    deinit {
        sqlite3_close_v2(db)
    }

    /// 索引库本身坏了（读写时报错）：删掉文件重开一个空的，之后由调用方全量修补
    func reset() throws {
        sqlite3_close_v2(db)
        db = nil
        if let url { Self.removeFiles(at: url) }
        try connect()
        wasReset = true
    }

    static func removeFiles(at url: URL) {
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: url.path(percentEncoded: false) + suffix))
        }
    }

    private func connect() throws {
        let path: String
        if let url {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            path = url.path(percentEncoded: false)
        } else {
            path = ":memory:"
        }
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            let message = lastError
            sqlite3_close_v2(db)
            db = nil
            throw IndexError.sqlite(message)
        }
        do {
            if url != nil { try execute("PRAGMA journal_mode=WAL") }
            // 派生数据：断电最多丢最后几笔（启动时核对会补上），换来每个事务少一次 fsync
            try execute("PRAGMA synchronous=NORMAL")
            let version = try userVersion()
            if version > Self.schemaVersion {
                // 新版本 App 建的格式（降级运行）：整个重建
                try execute("DROP TABLE IF EXISTS clip_search")
                try execute("DROP TABLE IF EXISTS clip_rank")
                try execute("DROP TABLE IF EXISTS pinned_state")
                try execute("DROP TABLE IF EXISTS meta")
                try execute("DROP TABLE IF EXISTS orphan_seen")
                wasReset = true
            }
            try execute("CREATE VIRTUAL TABLE IF NOT EXISTS clip_search USING fts5(uuid UNINDEXED, body, tokenize='trigram')")
            try execute("CREATE TABLE IF NOT EXISTS clip_rank(uuid TEXT PRIMARY KEY, rank INTEGER NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS pinned_state(uuid TEXT PRIMARY KEY, signature TEXT NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            try execute("CREATE TABLE IF NOT EXISTS orphan_seen(key TEXT PRIMARY KEY, first_seen REAL NOT NULL)")
            if version != Self.schemaVersion { try execute("PRAGMA user_version = \(Self.schemaVersion)") }
            // 读一遍：坏文件往往到第一次读才报错
            _ = try count()
            needsRepair = try metaValue(Self.needsRepairKey) == "1"
        } catch {
            sqlite3_close_v2(db)
            db = nil
            throw error
        }
    }

    // MARK: - 写

    /// 一批改动放进一个事务：entry 为 nil 表示删掉这一行。rank 撞上同一毫秒时往前挪一位
    func apply(_ changes: [(UUID, Entry?)]) throws {
        guard !changes.isEmpty else { return }
        try execute("BEGIN")
        do {
            let find = try prepare("SELECT rank FROM clip_rank WHERE uuid = ?")
            defer { sqlite3_finalize(find) }
            let deleteRow = try prepare("DELETE FROM clip_search WHERE rowid = ?")
            defer { sqlite3_finalize(deleteRow) }
            let forget = try prepare("DELETE FROM clip_rank WHERE uuid = ?")
            defer { sqlite3_finalize(forget) }
            let insert = try prepare("INSERT INTO clip_search(rowid, uuid, body) VALUES (?, ?, ?)")
            defer { sqlite3_finalize(insert) }
            let remember = try prepare("INSERT OR REPLACE INTO clip_rank(uuid, rank) VALUES (?, ?)")
            defer { sqlite3_finalize(remember) }

            for (uuid, entry) in changes {
                let key = uuid.uuidString
                // 先删旧行（rowid 存在 clip_rank 里）
                sqlite3_reset(find)
                bind(key, to: find, at: 1)
                if sqlite3_step(find) == SQLITE_ROW {
                    let rank = sqlite3_column_int64(find, 0)
                    sqlite3_reset(deleteRow)
                    sqlite3_bind_int64(deleteRow, 1, rank)
                    try step(deleteRow)
                    sqlite3_reset(forget)
                    bind(key, to: forget, at: 1)
                    try step(forget)
                }
                sqlite3_reset(find)
                guard let entry else { continue }

                var candidate = entry.rank
                var inserted = false
                for _ in 0..<8 where !inserted {
                    sqlite3_reset(insert)
                    sqlite3_bind_int64(insert, 1, candidate)
                    bind(key, to: insert, at: 2)
                    bind(entry.body, to: insert, at: 3)
                    let result = sqlite3_step(insert)
                    if result == SQLITE_DONE {
                        inserted = true
                    } else if result == SQLITE_CONSTRAINT {
                        candidate -= 1
                    } else {
                        throw IndexError.sqlite(lastError)
                    }
                }
                sqlite3_reset(insert)
                guard inserted else { throw IndexError.sqlite("rank collision") }
                sqlite3_reset(remember)
                bind(key, to: remember, at: 1)
                sqlite3_bind_int64(remember, 2, candidate)
                try step(remember)
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    func removeAll() throws {
        try execute("BEGIN")
        do {
            try execute("DELETE FROM clip_search")
            try execute("DELETE FROM clip_rank")
            try execute("DELETE FROM pinned_state")
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    /// 换成这一次核对到的 Pinboard 副本指纹
    func replacePinnedSignatures(_ signatures: [UUID: String]) throws {
        try execute("BEGIN")
        do {
            try execute("DELETE FROM pinned_state")
            let statement = try prepare("INSERT INTO pinned_state(uuid, signature) VALUES (?, ?)")
            defer { sqlite3_finalize(statement) }
            for (uuid, signature) in signatures {
                sqlite3_reset(statement)
                bind(uuid.uuidString, to: statement, at: 1)
                bind(signature, to: statement, at: 2)
                try step(statement)
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    /// 换成这一次巡检看到的孤儿行与各自第一次被看到的时间（连续 24 小时都是孤儿才处理）
    func replaceOrphanFirstSeen(_ firstSeen: [String: Date]) throws {
        try execute("BEGIN")
        do {
            try execute("DELETE FROM orphan_seen")
            let statement = try prepare("INSERT INTO orphan_seen(key, first_seen) VALUES (?, ?)")
            defer { sqlite3_finalize(statement) }
            for (key, date) in firstSeen {
                sqlite3_reset(statement)
                bind(key, to: statement, at: 1)
                sqlite3_bind_double(statement, 2, date.timeIntervalSince1970)
                try step(statement)
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    /// 记下 / 清掉"待修补"（跨启动保留）
    func setNeedsRepair(_ on: Bool) throws {
        let statement = try prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
        defer { sqlite3_finalize(statement) }
        bind(Self.needsRepairKey, to: statement, at: 1)
        bind(on ? "1" : "0", to: statement, at: 2)
        try step(statement)
        needsRepair = on
    }

    // MARK: - 查

    func count() throws -> Int {
        let statement = try prepare("SELECT count(*) FROM clip_rank")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw IndexError.sqlite(lastError) }
        return Int(sqlite3_column_int64(statement, 0))
    }

    /// 索引里的 uuid，按字典序分批取（修补时找出多余的行）
    func uuids(after: String?, limit: Int) throws -> [UUID] {
        let statement = try prepare("SELECT uuid FROM clip_rank WHERE uuid > ? ORDER BY uuid LIMIT ?")
        defer { sqlite3_finalize(statement) }
        bind(after ?? "", to: statement, at: 1)
        sqlite3_bind_int64(statement, 2, Int64(limit))
        var ids: [UUID] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let text = sqlite3_column_text(statement, 0), let id = UUID(uuidString: String(cString: text)) {
                ids.append(id)
            }
        }
        return ids
    }

    /// 上次巡检时的孤儿行与各自第一次被看到的时间
    func orphanFirstSeen() throws -> [String: Date] {
        let statement = try prepare("SELECT key, first_seen FROM orphan_seen")
        defer { sqlite3_finalize(statement) }
        var firstSeen: [String: Date] = [:]
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let key = sqlite3_column_text(statement, 0) else { continue }
            firstSeen[String(cString: key)] = Date(timeIntervalSince1970: sqlite3_column_double(statement, 1))
        }
        return firstSeen
    }

    /// 上次核对时的 Pinboard 副本指纹
    func pinnedSignatures() throws -> [UUID: String] {
        let statement = try prepare("SELECT uuid, signature FROM pinned_state")
        defer { sqlite3_finalize(statement) }
        var signatures: [UUID: String] = [:]
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let uuid = sqlite3_column_text(statement, 0), let signature = sqlite3_column_text(statement, 1),
                  let id = UUID(uuidString: String(cString: uuid)) else { continue }
            signatures[id] = String(cString: signature)
        }
        return signatures
    }

    /// 按最近使用倒序返回命中的 uuid；afterID 是上一页最后一条（keyset 翻页）
    func search(_ foldedNeedle: String, after afterID: UUID?, limit: Int) throws -> [UUID] {
        var before = Int64.max
        if let afterID {
            let statement = try prepare("SELECT rank FROM clip_rank WHERE uuid = ?")
            defer { sqlite3_finalize(statement) }
            bind(afterID.uuidString, to: statement, at: 1)
            if sqlite3_step(statement) == SQLITE_ROW {
                before = sqlite3_column_int64(statement, 0)
            }
        }
        let statement: OpaquePointer?
        if foldedNeedle.count >= 3 {
            // trigram：任意 3 个字符以上的子串都走索引；整串当一个短语
            statement = try prepare("SELECT uuid FROM clip_search WHERE clip_search MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?")
            bind("\"" + foldedNeedle.replacingOccurrences(of: "\"", with: "\"\"") + "\"", to: statement, at: 1)
        } else {
            // 1–2 个字符：trigram 用不上，按新旧顺序扫描，够 limit 条就停
            statement = try prepare("SELECT uuid FROM clip_search WHERE body LIKE ? ESCAPE '\\' AND rowid < ? ORDER BY rowid DESC LIMIT ?")
            bind("%" + Self.escapeLike(foldedNeedle) + "%", to: statement, at: 1)
        }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 2, before)
        sqlite3_bind_int64(statement, 3, Int64(limit))
        var ids: [UUID] = []
        while true {
            let result = sqlite3_step(statement)
            guard result == SQLITE_ROW else {
                if result != SQLITE_DONE { throw IndexError.sqlite(lastError) }
                break
            }
            if let text = sqlite3_column_text(statement, 0), let id = UUID(uuidString: String(cString: text)) {
                ids.append(id)
            }
        }
        return ids
    }

    // MARK: - 内部

    private func userVersion() throws -> Int32 {
        let statement = try prepare("PRAGMA user_version")
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw IndexError.sqlite(lastError) }
        return sqlite3_column_int(statement, 0)
    }

    private func metaValue(_ key: String) throws -> String? {
        let statement = try prepare("SELECT value FROM meta WHERE key = ?")
        defer { sqlite3_finalize(statement) }
        bind(key, to: statement, at: 1)
        guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { return nil }
        return String(cString: text)
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
            throw IndexError.sqlite(lastError)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            throw IndexError.sqlite(lastError)
        }
        return statement
    }

    private func step(_ statement: OpaquePointer?) throws {
        let result = sqlite3_step(statement)
        guard result == SQLITE_DONE || result == SQLITE_ROW else {
            throw IndexError.sqlite(lastError)
        }
    }

    private func bind(_ text: String, to statement: OpaquePointer?, at index: Int32) {
        sqlite3_bind_text(statement, index, text, -1, Self.transient)
    }

    private var lastError: String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "database not open"
    }

    private static func escapeLike(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }
}
