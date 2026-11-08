//
//  StoreFiles.swift
//  ClipData
//
//  数据目录里的库文件：两个库各建一个 ModelContainer（History 与 Pinboard 各用各的 coordinator：系统的 iCloud 镜像
//  占着同步库时，History 的读写不用排在它后面）、库打不开时用 SQLite 看一眼文件状况、把坏库整套挪进备份目录。
//  ModelContainer 打不开时 SwiftData 只抛不带原因的 loadIssueModelContainer，判断全靠这里。
//

import Foundation
import SQLite3
import SwiftData

enum StoreFiles {

    static let localName = "Local.store"
    static let cloudName = "Cloud.store"
    static let searchIndexName = "Search.sqlite"

    enum Configuration: Sendable, CaseIterable {
        case local
        case cloud

        var fileName: String {
            switch self {
            case .local: StoreFiles.localName
            case .cloud: StoreFiles.cloudName
            }
        }
    }

    /// 建一个库的 ModelContainer：两个库共用同一份 VersionedSchema 与迁移计划，各自只挂自己那个配置。
    /// cloudKitContainer：Pinboard 同步用的 iCloud 容器，nil = 不同步（只对 Cloud 库有意义； 约束 8：两个配置都显式写明）
    static func makeContainer(directory: URL, cloudKitContainer: String?, for configuration: Configuration) throws -> ModelContainer {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let modelConfiguration = switch configuration {
        case .local:
            ModelConfiguration(
                "Local",
                schema: Schema([HistoryClip.self, HistoryPayload.self, HistoryThumbnail.self]),
                url: directory.appending(path: localName),
                cloudKitDatabase: .none
            )
        case .cloud:
            ModelConfiguration(
                "Cloud",
                schema: Schema([PinboardRecord.self, PinnedClip.self, PinnedPayload.self, PinnedThumbnail.self]),
                url: directory.appending(path: cloudName),
                cloudKitDatabase: cloudKitContainer.map { .private($0) } ?? .none
            )
        }
        return try ModelContainer(
            for: Schema(versionedSchema: ClipAppSchemaV1.self),
            migrationPlan: ClipAppMigrationPlan.self,
            configurations: [modelConfiguration]
        )
    }

    // MARK: - 库文件状况

    enum Health: Equatable {
        case missing
        case ok
        case corrupt
        /// 被别的进程占着（如重启时旧实例还没退出）：等一会儿再试
        case busy
        /// 读不了（权限、磁盘出错等）：不动文件，等一会儿再试
        case unreadable(String)
    }

    /// 用 SQLite 直接看一眼库文件：打不开、校验不过就算坏了。quick_check 会读一遍整个文件，只在 ModelContainer 打不开时才走到这里
    static func probe(_ url: URL) -> Health {
        let path = url.path(percentEncoded: false)
        guard FileManager.default.fileExists(atPath: path) else { return .missing }
        var db: OpaquePointer?
        defer { sqlite3_close_v2(db) }
        // 只读打开 WAL 库需要能建 -shm，这里用读写方式打开，但只读不写
        let opened = sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil)
        guard opened == SQLITE_OK else { return classify(opened) }
        var statement: OpaquePointer?
        let prepared = sqlite3_prepare_v2(db, "PRAGMA quick_check(1)", -1, &statement, nil)
        defer { sqlite3_finalize(statement) }
        guard prepared == SQLITE_OK else { return classify(prepared) }
        let result = sqlite3_step(statement)
        guard result == SQLITE_ROW else { return classify(result) }
        let verdict = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? ""
        return verdict == "ok" ? .ok : .corrupt
    }

    private static func classify(_ code: Int32) -> Health {
        switch code & 0xFF {
        case SQLITE_NOTADB, SQLITE_CORRUPT: .corrupt
        case SQLITE_BUSY, SQLITE_LOCKED: .busy
        default: .unreadable(String(cString: sqlite3_errstr(code)))
        }
    }

    /// 磁盘快满了（库打不开时先看这个：满了就只等重试，绝不挪文件）
    static func isLowOnSpace(_ directory: URL) -> Bool {
        var probe = directory
        while !FileManager.default.fileExists(atPath: probe.path(percentEncoded: false)), probe.pathComponents.count > 1 {
            probe.deleteLastPathComponent()
        }
        let values = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        guard let available = values?.volumeAvailableCapacityForImportantUsage else { return false }
        return available < 200 * 1024 * 1024
    }

    // MARK: - 挪走坏库

    /// 备份目录：数据目录里的 Recovered-yyyy-MM-dd-HHmmss
    static func backupFolder(in directory: URL, date: Date = .now) -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return directory.appending(path: "Recovered-" + formatter.string(from: date), directoryHint: .isDirectory)
    }

    /// 把一个库的全部文件（主文件、-wal、-shm、外部存储目录 .<名字>_SUPPORT）挪进备份目录
    static func moveStore(_ configuration: Configuration, from directory: URL, to backup: URL) throws {
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        let name = configuration.fileName
        let base = (name as NSString).deletingPathExtension
        for item in [name, name + "-wal", name + "-shm", "." + base + "_SUPPORT"] {
            let source = directory.appending(path: item)
            guard FileManager.default.fileExists(atPath: source.path(percentEncoded: false)) else { continue }
            try FileManager.default.moveItem(at: source, to: backup.appending(path: item))
        }
    }
}
