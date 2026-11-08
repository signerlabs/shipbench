//
//  CloudSync.swift
//  ClipData
//
//  iCloud 同步（，只同步 Pinboard）对外的值类型：设置里显示的同步状态（Y1），
//  以及"别的 Mac 改了数据、已合并好，界面该重读了"的通知。
//

import Foundation

/// 设置里显示的同步状态
public struct CloudSyncStatus: Sendable, Equatable {

    public enum Problem: Sendable, Equatable {
        /// 这台 Mac 没登录 iCloud，或在系统设置里关了本 App 的 iCloud
        case notSignedIn
        /// iCloud 账户暂时不可用（如需要重新输入密码）
        case accountUnavailable
        /// iCloud 空间已满
        case quotaExceeded
        /// 连不上网络或 iCloud 服务（恢复后自动继续）
        case networkUnavailable
        /// 其他错误（系统给的描述）
        case other(String)
    }

    /// 正在上传或下载
    public var isSyncing: Bool
    /// 最近一次同步成功的时间
    public var lastSyncedAt: Date?
    public var problem: Problem?

    public init(isSyncing: Bool = false, lastSyncedAt: Date? = nil, problem: Problem? = nil) {
        self.isSyncing = isSyncing
        self.lastSyncedAt = lastSyncedAt
        self.problem = problem
    }
}

/// 同步层发给 App 的消息
public enum CloudSyncUpdate: Sendable {
    case status(CloudSyncStatus)
    /// 收到了别的 Mac 的改动（已合并去重、更新好搜索索引）：界面重读
    case dataChanged
}
