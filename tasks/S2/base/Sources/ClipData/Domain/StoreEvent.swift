//
//  StoreEvent.swift
//  ClipData
//
//  数据库的可用状态（SwiftDataClipRepository.storeEvents）。库文件出问题时按用户 2026-10-10 定的规则处理：
//  搜索索引坏了静默重建；Pinboard 同步库打不开就本次不同步、History 照常；库损坏或升级失败就把原文件挪进备份目录、开新库；
//  磁盘满等暂时问题不动文件、退避重试。界面据此提示用户；收到 .available 后重读列表。
//

import Foundation

public enum StoreEvent: Sendable, Equatable {
    /// 数据库已打开、可以读写（首次打开、恢复后、暂时打不开又重试成功后都会发）
    case available
    /// 库损坏或升级失败：原文件已挪进 backupFolder（数据目录里的 Recovered-yyyy-MM-dd-HHmmss），换成了新库。
    /// historyReset = 本机 History 是新库（无法找回）；pinboardsReset = Pinboard 库是新库（开着 iCloud 同步时会从 iCloud 拉回）
    case recovered(backupFolder: URL, historyReset: Bool, pinboardsReset: Bool)
    /// Pinboard 的同步库接不上 iCloud：本次运行不同步（History 与本机的 Pinboard 照常），reason 是系统给的描述
    case cloudDisabled(reason: String)
    /// 暂时打不开（磁盘已满、文件被占用等）：没动任何文件，会自动退避重试；期间读写调用抛 ClipRepositoryError.unavailable
    case unavailable(reason: String)
    /// 搜索索引在后台修补 / 重建：true 开始、false 结束。期间搜索照常走索引——修补时旧行都在、结果完整；
    /// 索引文件丢了或坏了重建时从最新的条目逐批补起，先搜得到最近的内容
    case searchIndexRebuilding(Bool)
}
