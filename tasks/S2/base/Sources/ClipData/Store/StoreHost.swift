//
//  StoreHost.swift
//  ClipData
//
//  打开数据库并看住它（SwiftDataClipRepository 的每个调用都经这里拿写入 actor）。两个库各开一个 ModelContainer、各自判断，
//  打不开时按用户 2026-10-10 定的规则处理：
//  - 搜索索引坏了：静默删掉重建（SearchIndex.open）
//  - Pinboard 同步库接不上 iCloud：只把它以不同步方式重开，History 照常，报 cloudDisabled
//  - 库损坏或升级失败：只把坏的那个库整套挪进 Recovered-yyyy-MM-dd-HHmmss/、开新库，报 recovered（每次运行最多挪一次；
//    同步库换新库后开着同步的话 Pinboard 会从 iCloud 拉回）
//  - 磁盘已满、文件被占用等暂时问题：不动文件，报 unavailable，退避重试（期间调用直接抛 ClipRepositoryError.unavailable）
//  ModelContainer 打不开时 SwiftData 只抛不带原因的错误，是哪个库、什么问题靠 StoreFiles 自己判断。
//  写入 actor 必须在主线程之外创建，打开一律在 Task.detached 里做。
//

import Foundation
import SwiftData

actor StoreHost {

    /// 建 ModelContainer 的方式（测试里替换成会出错的，模拟同步配置出错、暂时打不开）
    typealias ContainerFactory = @Sendable (URL, String?, StoreFiles.Configuration) throws -> ModelContainer

    private let directory: URL
    private let cloudKitContainer: String?
    private let events: AsyncStream<StoreEvent>.Continuation
    private let makeContainer: ContainerFactory
    private let firstRetryDelay: Duration
    /// 同步库的数据在后台装好或变了：让界面重读（接到 cloudUpdates 的 .dataChanged）
    private let onCloudDataChanged: @Sendable () -> Void

    private var store: ClipStore?
    private var opening: Task<ClipStore, any Error>?
    /// 最近一次打开失败的原因：退避重试期间调用直接抛出，不再排队等
    private var failureReason: String?
    private var retryDelay: Duration
    private var retryTask: Task<Void, Never>?
    /// 本次运行已经挪过一次坏库：之后再打不开只当暂时问题重试，绝不反复挪
    private var didRecover = false
    /// Pinboard 同步库这次没接上 iCloud 的原因（同步状态里要显示）
    private(set) var cloudDisabledReason: String?
    private weak var monitor: CloudSyncMonitor?

    init(
        directory: URL,
        cloudKitContainer: String?,
        events: AsyncStream<StoreEvent>.Continuation,
        firstRetryDelay: Duration = .seconds(2),
        makeContainer: @escaping ContainerFactory = StoreFiles.makeContainer,
        onCloudDataChanged: @escaping @Sendable () -> Void = {}
    ) {
        self.directory = directory
        self.cloudKitContainer = cloudKitContainer
        self.events = events
        self.makeContainer = makeContainer
        self.firstRetryDelay = firstRetryDelay
        self.onCloudDataChanged = onCloudDataChanged
        retryDelay = firstRetryDelay
    }

    /// 同步状态的旁听者：同步库没接上 iCloud 时让它在设置里显示原因
    func attach(_ monitor: CloudSyncMonitor) async {
        self.monitor = monitor
        if let cloudDisabledReason { await monitor.cloudDisabled(cloudDisabledReason) }
    }

    /// 当前可用的写入 actor：没打开就打开（同时只开一次，其他调用一起等）；正在退避重试就直接抛 unavailable
    func store() async throws -> ClipStore {
        if let store { return store }
        if opening == nil {
            if let failureReason { throw ClipRepositoryError.unavailable(reason: failureReason) }
            opening = Task { try await performOpen() }
        }
        guard let opening else { throw ClipRepositoryError.unavailable(reason: failureReason ?? "") }
        return try await opening.value
    }

    private func performOpen() async throws -> ClipStore {
        defer { opening = nil }
        let directory = directory
        let cloudKitContainer = cloudKitContainer
        let makeContainer = makeContainer
        let events = events
        let onCloudDataChanged = onCloudDataChanged
        let allowRecovery = !didRecover
        do {
            let result = try await Task.detached(priority: .userInitiated) {
                let result = try Self.openWithRecovery(
                    directory: directory,
                    cloudKitContainer: cloudKitContainer,
                    allowRecovery: allowRecovery,
                    makeContainer: makeContainer,
                    onEvent: { events.yield($0) },
                    onCloudDataChanged: onCloudDataChanged
                )
                try await result.store.prepare()
                return result
            }.value
            store = result.store
            failureReason = nil
            retryDelay = firstRetryDelay
            if result.didRecover { didRecover = true }
            if let reason = result.cloudDisabledReason {
                cloudDisabledReason = reason
                await monitor?.cloudDisabled(reason)
            }
            for event in result.events { events.yield(event) }
            events.yield(.available)
            let store = result.store
            Task.detached(priority: .userInitiated) { await store.startBackgroundWork() }
            return store
        } catch {
            let reason = Self.describe(error)
            failureReason = reason
            ClipStore.log.error("数据库打不开，稍后重试：\(reason, privacy: .public)")
            events.yield(.unavailable(reason: reason))
            scheduleRetry()
            throw ClipRepositoryError.unavailable(reason: reason)
        }
    }

    /// 退避重试：2、4、8 … 秒，最长 5 分钟
    private func scheduleRetry() {
        retryTask?.cancel()
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, .seconds(300))
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.retry()
        }
    }

    private func retry() async {
        guard store == nil, opening == nil else { return }
        failureReason = nil
        _ = try? await store()
    }

    // MARK: - 打开与恢复

    struct OpenResult: Sendable {
        let store: ClipStore
        /// 打开过程中发生的事（recovered / cloudDisabled），打开成功后按顺序发给界面
        let events: [StoreEvent]
        let cloudDisabledReason: String?

        var didRecover: Bool {
            events.contains { if case .recovered = $0 { true } else { false } }
        }
    }

    /// 暂时问题（磁盘满、文件被占用、读不了）：不动文件，等重试
    struct TransientError: Error, CustomStringConvertible {
        let description: String
    }

    /// 按规则打开两个库，各自判断：本机库打不开 → 空间不足 / 被占用 / 读不了就等重试，坏了才挪走换新；
    /// 同步库接 iCloud 打不开 → 先试不同步打开（文件没问题就只是本次不同步），文件本身打不开再按同样规则挪走换新
    static func openWithRecovery(
        directory: URL,
        cloudKitContainer: String?,
        allowRecovery: Bool,
        makeContainer: ContainerFactory,
        onEvent: @escaping @Sendable (StoreEvent) -> Void,
        onCloudDataChanged: @escaping @Sendable () -> Void = {}
    ) throws -> OpenResult {
        let indexURL = directory.appending(path: StoreFiles.searchIndexName)
        let backup = StoreFiles.backupFolder(in: directory)
        var moved: [StoreFiles.Configuration] = []

        /// 打不开的库：看清原因。暂时问题（空间不足、被占用、读不了）抛出等重试；坏了或这一版打不开（升级失败）就整套挪进备份目录
        func moveAsideIfBroken(_ configuration: StoreFiles.Configuration, after error: any Error) throws {
            if StoreFiles.isLowOnSpace(directory) {
                throw TransientError(description: "Not enough disk space (\(describe(error)))")
            }
            switch StoreFiles.probe(directory.appending(path: configuration.fileName)) {
            case .busy:
                throw TransientError(description: "\(configuration.fileName) is in use by another process")
            case .unreadable(let reason):
                throw TransientError(description: "\(configuration.fileName): \(reason)")
            case .missing:
                // 文件不在却建不出来（权限、磁盘出错）：挪什么都没用
                throw TransientError(description: describe(error))
            case .corrupt, .ok:
                guard allowRecovery else { throw TransientError(description: describe(error)) }
                try StoreFiles.moveStore(configuration, from: directory, to: backup)
                moved.append(configuration)
            }
        }

        // 1. 本机库（History，永不同步）
        let local: ModelContainer
        do {
            local = try makeContainer(directory, nil, .local)
        } catch {
            try moveAsideIfBroken(.local, after: error)
            local = try makeContainer(directory, nil, .local)
        }

        // 2. 同步库（Pinboard）。本机库刚挪过、同步库却暂时打不开时，先把"已换新库"告诉界面再等重试（重试时本机库已是新的，不会再报）
        var cloud: ModelContainer
        var mirrored = false
        var disabledReason: String?
        do {
            if let cloudKitContainer {
                do {
                    cloud = try makeContainer(directory, cloudKitContainer, .cloud)
                    mirrored = true
                } catch {
                    let reason = describe(error)
                    if let plain = try? makeContainer(directory, nil, .cloud) {
                        // 文件没问题，是接 iCloud 出错：本次不同步，History 与本机的 Pinboard 照常
                        ClipStore.log.error("Pinboard 同步库接不上 iCloud，本次不同步：\(reason, privacy: .public)")
                        cloud = plain
                        disabledReason = reason
                    } else {
                        try moveAsideIfBroken(.cloud, after: error)
                        do {
                            cloud = try makeContainer(directory, cloudKitContainer, .cloud)
                            mirrored = true
                        } catch {
                            cloud = try makeContainer(directory, nil, .cloud)
                            disabledReason = describe(error)
                        }
                    }
                }
            } else {
                do {
                    cloud = try makeContainer(directory, nil, .cloud)
                } catch {
                    try moveAsideIfBroken(.cloud, after: error)
                    cloud = try makeContainer(directory, nil, .cloud)
                }
            }
        } catch {
            if !moved.isEmpty {
                SearchIndex.removeFiles(at: indexURL)
                onEvent(.recovered(backupFolder: backup, historyReset: moved.contains(.local), pinboardsReset: moved.contains(.cloud)))
            }
            throw error
        }

        // 3. 搜索索引（派生数据：换过库就删掉重建）
        var events: [StoreEvent] = []
        if !moved.isEmpty {
            SearchIndex.removeFiles(at: indexURL)
            ClipStore.log.error("库损坏或升级失败，已挪进 \(backup.lastPathComponent, privacy: .public) 并开新库")
            events.append(.recovered(backupFolder: backup, historyReset: moved.contains(.local), pinboardsReset: moved.contains(.cloud)))
        }
        if let disabledReason { events.append(.cloudDisabled(reason: disabledReason)) }
        let index = try SearchIndex.open(url: indexURL)
        let store = ClipStore(
            localContainer: local,
            cloudContainer: cloud,
            isCloudMirrored: mirrored,
            index: index,
            onEvent: onEvent,
            onCloudDataChanged: onCloudDataChanged
        )
        return OpenResult(store: store, events: events, cloudDisabledReason: disabledReason)
    }

    static func describe(_ error: any Error) -> String {
        if let error = error as? TransientError { return error.description }
        if case .unavailable(let reason)? = error as? ClipRepositoryError { return reason }
        return (error as NSError).localizedDescription
    }
}
