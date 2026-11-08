//
//  ClipAppSchema.swift
//  ClipData
//
//  SwiftData 数据结构，从 1.0 起用 VersionedSchema，上线后只做轻量迁移（新增可选字段）。
//  - Local 配置（永不接入同步）：HistoryClip + 1:1 的 HistoryPayload / HistoryThumbnail
//  - Cloud 配置（接 CloudKit 私有库）：PinboardRecord、PinnedClip（收进 Pinboard 的副本）+ 1:1 的 payload / 缩略图
//  两边不建关系，用 uuid 关联：同一 uuid 在界面上合成一张卡。
//  两个配置各开一个 ModelContainer（各自的 coordinator，见 StoreFiles）：系统的 iCloud 镜像占着同步库时，History 的读写不用等它。
//  两个容器共用这一份 VersionedSchema 与迁移计划（各自只挂自己那个配置）：已有的库照常打开，将来升版本两个库各自做轻量迁移。
//  约束：主表只放轻字段；不声明集合类型属性；enum 存 raw；属性都有默认值、关系都可选且写反向、
//  不用 #Unique / .deny（CloudKit 合规）；不依赖 cascade，删除时先删子表再删主表。
//

import Foundation
import SwiftData

enum ClipAppSchemaV1: VersionedSchema {
    static var versionIdentifier: Schema.Version { Schema.Version(1, 0, 0) }

    static var models: [any PersistentModel.Type] {
        [
            HistoryClip.self, HistoryPayload.self, HistoryThumbnail.self,
            PinboardRecord.self, PinnedClip.self, PinnedPayload.self, PinnedThumbnail.self,
        ]
    }

    // MARK: - Local：History

    @Model
    final class HistoryClip {
        // trashedAt 不单独建索引：几乎全是 nil，SQLite 会把 `trashedAt == nil` 当等值条件选它、再全表排序（10 万条每页 ~95 ms）；
        // 复合索引 (trashedAt, lastUsedAt) 让"没删的、按最近使用倒序"一路走索引。按 uuid / isExample 取时谓词不带 trashedAt，取回后在内存里过滤
        #Index<HistoryClip>([\.lastUsedAt], [\.contentHash], [\.uuid], [\.trashedAt, \.lastUsedAt], [\.isExample])

        var uuid: UUID = UUID()
        var createdAt: Date = Date.now
        /// 列表排序；"移到最前"只改它（由写入 actor 保证严格递增、不重复）
        var lastUsedAt: Date = Date.now
        var kindRaw: String = ClipKind.text.rawValue
        var title: String?
        /// 卡片预览（截断）
        var preview: String = ""
        var characterCount: Int = 0
        var sourceAppBundleID: String?
        var sourceAppName: String?
        var colorHex: String?
        /// 文件名与路径：不声明集合属性，多个用换行连接
        var fileNamesText: String = ""
        var filePathsText: String = ""
        var imageWidth: Int?
        var imageHeight: Int?
        var byteSize: Int = 0
        var contentHash: String = ""
        /// 检索用的折叠文本（限长）：搜索旁路索引由它维护与重建
        var searchText: String = ""
        /// 首次打开的示例、且用户还没动过
        var isExample: Bool = false
        /// 软删除：界面隐藏，⌘Z 只需置回 nil；之后由后台逐条物理删除
        var trashedAt: Date?

        @Relationship(deleteRule: .nullify, inverse: \HistoryPayload.clip) var payload: HistoryPayload?
        @Relationship(deleteRule: .nullify, inverse: \HistoryThumbnail.clip) var thumbnail: HistoryThumbnail?

        init() {}
    }

    @Model
    final class HistoryPayload {
        /// 全部类型表示归档成一个 Data（binary plist），只在粘贴、拖拽时读
        @Attribute(.externalStorage) var archive: Data?
        var clip: HistoryClip?

        init(archive: Data?) {
            self.archive = archive
        }
    }

    @Model
    final class HistoryThumbnail {
        @Attribute(.externalStorage) var data: Data?
        var clip: HistoryClip?

        init(data: Data?) {
            self.data = data
        }
    }

    // MARK: - Cloud：Pinboard

    @Model
    final class PinboardRecord {
        #Index<PinboardRecord>([\.uuid], [\.sortKey])

        var uuid: UUID = UUID()
        var name: String = ""
        var colorRaw: String = PinboardColor.blue.rawValue
        /// 分数索引：挪动位置只改被挪的那一个，适合同步时"后写者胜"
        var sortKey: Double = 0
        var isExample: Bool = false
        var createdAt: Date = Date.now

        init() {}
    }

    @Model
    final class PinnedClip {
        #Index<PinnedClip>([\.pinboardID, \.pinSortKey], [\.contentHash], [\.uuid], [\.trashedAt, \.lastUsedAt], [\.isExample])

        var uuid: UUID = UUID()
        var createdAt: Date = Date.now
        var lastUsedAt: Date = Date.now
        var kindRaw: String = ClipKind.text.rawValue
        var title: String?
        var preview: String = ""
        var characterCount: Int = 0
        var sourceAppBundleID: String?
        var sourceAppName: String?
        var colorHex: String?
        var fileNamesText: String = ""
        var filePathsText: String = ""
        var imageWidth: Int?
        var imageHeight: Int?
        var byteSize: Int = 0
        var contentHash: String = ""
        var searchText: String = ""
        var isExample: Bool = false
        var trashedAt: Date?
        /// 所属 Pinboard（标量外键，不建关系，）
        var pinboardID: UUID?
        /// Pinboard 内的排序键（分数索引）
        var pinSortKey: Double = 0

        @Relationship(deleteRule: .nullify, inverse: \PinnedPayload.clip) var payload: PinnedPayload?
        @Relationship(deleteRule: .nullify, inverse: \PinnedThumbnail.clip) var thumbnail: PinnedThumbnail?

        init() {}
    }

    @Model
    final class PinnedPayload {
        @Attribute(.externalStorage) var archive: Data?
        var clip: PinnedClip?

        init(archive: Data?) {
            self.archive = archive
        }
    }

    @Model
    final class PinnedThumbnail {
        @Attribute(.externalStorage) var data: Data?
        var clip: PinnedClip?

        init(data: Data?) {
            self.data = data
        }
    }
}

enum ClipAppMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] { [ClipAppSchemaV1.self] }
    static var stages: [MigrationStage] { [] }
}

typealias HistoryClip = ClipAppSchemaV1.HistoryClip
typealias HistoryPayload = ClipAppSchemaV1.HistoryPayload
typealias HistoryThumbnail = ClipAppSchemaV1.HistoryThumbnail
typealias PinboardRecord = ClipAppSchemaV1.PinboardRecord
typealias PinnedClip = ClipAppSchemaV1.PinnedClip
typealias PinnedPayload = ClipAppSchemaV1.PinnedPayload
typealias PinnedThumbnail = ClipAppSchemaV1.PinnedThumbnail

/// History 条目、Pinboard 副本及副本的值快照（PinnedValue）共有的只读字段：合成卡片、写搜索索引时按它读
protocol ClipFields {
    var uuid: UUID { get }
    var createdAt: Date { get }
    var lastUsedAt: Date { get }
    var kindRaw: String { get }
    var title: String? { get }
    var preview: String { get }
    var characterCount: Int { get }
    var sourceAppBundleID: String? { get }
    var sourceAppName: String? { get }
    var colorHex: String? { get }
    var fileNamesText: String { get }
    var filePathsText: String { get }
    var imageWidth: Int? { get }
    var imageHeight: Int? { get }
    var byteSize: Int { get }
    var contentHash: String { get }
    var searchText: String { get }
    var isExample: Bool { get }
}

/// History 条目与 Pinboard 副本共有的字段：互相复制时按它读写
protocol StoredClip: AnyObject, ClipFields {
    var uuid: UUID { get set }
    var createdAt: Date { get set }
    var lastUsedAt: Date { get set }
    var kindRaw: String { get set }
    var title: String? { get set }
    var preview: String { get set }
    var characterCount: Int { get set }
    var sourceAppBundleID: String? { get set }
    var sourceAppName: String? { get set }
    var colorHex: String? { get set }
    var fileNamesText: String { get set }
    var filePathsText: String { get set }
    var imageWidth: Int? { get set }
    var imageHeight: Int? { get set }
    var byteSize: Int { get set }
    var contentHash: String { get set }
    var searchText: String { get set }
    var isExample: Bool { get set }
    var trashedAt: Date? { get set }
}

extension HistoryClip: StoredClip {}
extension PinnedClip: StoredClip {}
