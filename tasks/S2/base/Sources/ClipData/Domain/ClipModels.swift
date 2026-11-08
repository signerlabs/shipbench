//
//  ClipModels.swift
//  ClipData
//
//  领域值类型：界面与数据层之间只传这些值，界面绝不直接持有 SwiftData 的 @Model。
//  mock 与 SwiftData 实现产出同一套值，换数据层时视图零改动。界面文案（类型名、颜色名）在 App 里另行扩展。
//

import Foundation

// MARK: - 条目类型

/// 剪贴板条目的类型（持久化时只存 rawValue， 约束 2）
public enum ClipKind: String, CaseIterable, Codable, Sendable {
    case text
    case richText
    case link
    case image
    case file
    case color
}

// MARK: - 条目

/// 一条剪贴板记录：卡片展示所需的全部轻字段；完整内容另取（ClipPayload，只在取用时读）
public struct ClipItem: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var kind: ClipKind
    /// 用户起的标题（重命名，）；nil = 未命名
    public var title: String?
    /// 卡片预览：文本开头、链接网址、首个文件名、颜色 hex（已截断， 瘦主表）
    public var preview: String
    /// 文本类的字符总数（卡片底部显示）
    public var characterCount: Int
    public var sourceAppBundleID: String?
    public var sourceAppName: String?
    public var createdAt: Date
    /// 最近一次复制或取用的时间：History 按它倒序；"移到最前"只改它
    public var lastUsedAt: Date
    /// 是否在 History 里（在 History 删除只清这一项， B5）
    public var isInHistory: Bool
    /// 所属 Pinboard；nil = 未收进任何 Pinboard
    public var pinboardID: UUID?
    /// 在 Pinboard 内的排序键（分数索引，）
    public var pinSortKey: Double?
    /// 颜色类条目的 hex（如 "#3A7BFF"）
    public var colorHex: String?
    /// 文件类条目的全部文件名
    public var fileNames: [String]
    /// 图片类条目的像素尺寸
    public var imageWidth: Int?
    public var imageHeight: Int?
    /// 内容体积（字节）
    public var byteSize: Int
    /// 判重键
    public var contentHash: String
    /// 文件类：原文件已被移走或删除（卡片显示 "File not found"， C1）；由数据层在取出时核对
    public var isFileMissing: Bool

    public init(
        id: UUID,
        kind: ClipKind,
        title: String? = nil,
        preview: String,
        characterCount: Int,
        sourceAppBundleID: String? = nil,
        sourceAppName: String? = nil,
        createdAt: Date,
        lastUsedAt: Date,
        isInHistory: Bool,
        pinboardID: UUID? = nil,
        pinSortKey: Double? = nil,
        colorHex: String? = nil,
        fileNames: [String] = [],
        imageWidth: Int? = nil,
        imageHeight: Int? = nil,
        byteSize: Int,
        contentHash: String,
        isFileMissing: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.preview = preview
        self.characterCount = characterCount
        self.sourceAppBundleID = sourceAppBundleID
        self.sourceAppName = sourceAppName
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.isInHistory = isInHistory
        self.pinboardID = pinboardID
        self.pinSortKey = pinSortKey
        self.colorHex = colorHex
        self.fileNames = fileNames
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.byteSize = byteSize
        self.contentHash = contentHash
        self.isFileMissing = isFileMissing
    }

    /// 用户起过标题时返回标题，否则 nil（卡片改显示类型名）
    public var displayTitle: String? {
        guard let title, !title.isEmpty else { return nil }
        return title
    }

    /// History 与搜索的排序：lastUsedAt 倒序，同一时刻按 id 倒序（与 keyset 游标一致）
    public static func newerFirst(_ lhs: ClipItem, _ rhs: ClipItem) -> Bool {
        if lhs.lastUsedAt != rhs.lastUsedAt { return lhs.lastUsedAt > rhs.lastUsedAt }
        return lhs.id.uuidString > rhs.id.uuidString
    }

    /// 是否排在游标之后（keyset 分页取下一页）
    public func comes(after cursor: ClipCursor) -> Bool {
        if lastUsedAt != cursor.lastUsedAt { return lastUsedAt < cursor.lastUsedAt }
        return id.uuidString < cursor.id.uuidString
    }
}

// MARK: - Pinboard

/// Pinboard：用户自己的分类
public struct Pinboard: Identifiable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var color: PinboardColor
    /// 排序键（分数索引，）
    public var sortKey: Double

    public init(id: UUID, name: String, color: PinboardColor, sortKey: Double) {
        self.id = id
        self.name = name
        self.color = color
        self.sortKey = sortKey
    }
}

/// Pinboard 颜色（持久化只存 rawValue；色值与名称在 App 里映射）
public enum PinboardColor: String, CaseIterable, Codable, Sendable, Identifiable {
    case red, orange, yellow, green, mint, teal, blue, indigo, purple, pink, graphite

    public var id: String { rawValue }
}

// MARK: - 查询与分页

/// 面板当前看的列表
public enum ClipScope: Hashable, Sendable {
    case history
    case pinboard(UUID)
}

/// 一次列表查询：搜索词非空时跨 History 与全部 Pinboard
public struct ClipQuery: Hashable, Sendable {
    public var scope: ClipScope
    public var searchText: String

    public init(scope: ClipScope, searchText: String = "") {
        self.scope = scope
        self.searchText = searchText
    }

    public var trimmedSearchText: String { searchText.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isSearching: Bool { !trimmedSearchText.isEmpty }
}

/// keyset 分页游标：按 lastUsedAt 倒序，不用 offset
public struct ClipCursor: Hashable, Sendable {
    public let lastUsedAt: Date
    public let id: UUID

    public init(lastUsedAt: Date, id: UUID) {
        self.lastUsedAt = lastUsedAt
        self.id = id
    }
}

public struct ClipPage: Sendable {
    public var items: [ClipItem]
    public var nextCursor: ClipCursor?

    public init(items: [ClipItem], nextCursor: ClipCursor?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

// MARK: - 完整内容

/// 一项剪贴板内容的一种类型表示（UTI → 数据）
public struct ClipRepresentation: Hashable, Codable, Sendable {
    public var type: String
    public var data: Data

    public init(type: String, data: Data) {
        self.type = type
        self.data = data
    }
}

/// 取用时才读的完整内容：剪贴板上的每一项（多文件就是多项）及其全部类型表示，原样写回
public struct ClipPayload: Hashable, Codable, Sendable {
    public var items: [[ClipRepresentation]]

    public init(items: [[ClipRepresentation]]) {
        self.items = items
    }
}

// MARK: - 采集与删除

/// 新采集的一条：剪贴板采集、首次打开的示例、Debug 的模拟复制共用这一入口
public struct ClipDraft: Sendable {
    public var kind: ClipKind
    public var preview: String
    /// 可搜索的全文（文本、网址、文件路径等）
    public var fullText: String
    public var characterCount: Int
    public var sourceAppBundleID: String?
    public var sourceAppName: String?
    public var colorHex: String?
    public var fileNames: [String]
    /// 文件类条目的原文件路径（核对"文件已不在"）
    public var filePaths: [String]
    public var imageWidth: Int?
    public var imageHeight: Int?
    public var byteSize: Int
    public var contentHash: String
    public var payload: ClipPayload
    /// 图片类的卡片缩略图（采集时在后台生成， ClipThumbnail）
    public var thumbnail: Data?

    public init(
        kind: ClipKind,
        preview: String,
        fullText: String,
        characterCount: Int,
        sourceAppBundleID: String? = nil,
        sourceAppName: String? = nil,
        colorHex: String? = nil,
        fileNames: [String] = [],
        filePaths: [String] = [],
        imageWidth: Int? = nil,
        imageHeight: Int? = nil,
        byteSize: Int,
        contentHash: String,
        payload: ClipPayload,
        thumbnail: Data? = nil
    ) {
        self.kind = kind
        self.preview = preview
        self.fullText = fullText
        self.characterCount = characterCount
        self.sourceAppBundleID = sourceAppBundleID
        self.sourceAppName = sourceAppName
        self.colorHex = colorHex
        self.fileNames = fileNames
        self.filePaths = filePaths
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
        self.byteSize = byteSize
        self.contentHash = contentHash
        self.payload = payload
        self.thumbnail = thumbnail
    }
}

/// 从哪里删除（ B5：History 与 Pinboard 两边互不影响；搜索结果里同一内容只出现一次，删除即两边都删）
public enum ClipRemovalScope: Hashable, Sendable {
    case history
    case pinboard
    case everywhere
}

/// 一次删除的回执：⌘Z 凭它恢复
public struct ClipRemoval: Sendable {
    /// 删除前的快照
    public let item: ClipItem
    public let scope: ClipRemovalScope

    public init(item: ClipItem, scope: ClipRemovalScope) {
        self.item = item
        self.scope = scope
    }
}
