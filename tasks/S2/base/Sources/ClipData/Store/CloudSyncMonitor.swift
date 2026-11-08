//
//  CloudSyncMonitor.swift
//  ClipData
//
//  iCloud 同步的旁听者（，只在打开同步时创建）：SwiftData 的 CloudKit 镜像每做一次设置 / 导入 / 导出都会发事件，
//  这里据此算出设置页显示的状态（Y1：正在同步、最近同步时间、错误原因），并在导入别的 Mac 的改动后
//  让写入 actor 合并去重、更新索引，有变化再通知界面重读。
//  合并排队：正在合并时又来了几次导入，只记一笔，合并完再跑一次（几次导入合成一次合并，不为每批导入各跑一遍全量）。
//  iCloud 账户变了（退出、换账户时系统会清掉同步库）：稍等后合并一次并让界面重读。
//

import CloudKit
import CoreData
import Foundation

actor CloudSyncMonitor {

    /// 从系统事件里取出的值（事件对象本身不能跨线程）
    struct Event: Sendable {
        enum Kind: Sendable { case setup, `import`, export }
        let id: UUID
        let kind: Kind
        let isFinished: Bool
        let succeeded: Bool
        let endDate: Date?
        let problem: CloudSyncStatus.Problem?
    }

    private let containerIdentifier: String
    private let host: StoreHost
    private let updates: AsyncStream<CloudSyncUpdate>.Continuation
    private var status = CloudSyncStatus(lastSyncedAt: UserDefaults.standard.object(forKey: CloudSyncMonitor.lastSyncedKey) as? Date)
    /// 进行中的导入 / 导出
    private var running = Set<UUID>()
    private var accountProblem: CloudSyncStatus.Problem?
    /// 各类事件最近一次失败的原因，同类事件成功后清掉
    private var failures: [Event.Kind: CloudSyncStatus.Problem] = [:]
    /// 同步库这次没接上 iCloud（以不同步方式打开）：设置里一直显示这个原因
    private var disabledReason: String?
    /// 有待跑的合并 / 正在合并 / 合并完不管有无变化都让界面重读（账户变化后）
    private var mergeRequested = false
    private var merging = false
    private var notifyAfterMerge = false

    /// 最近同步时间存起来，下次启动一打开设置就有
    private static let lastSyncedKey = "sync.lastSyncedAt"
    /// 账户变化后等系统清掉 / 重建同步库再合并
    private static let accountChangeDelay: Duration = .seconds(3)

    init(containerIdentifier: String, host: StoreHost, updates: AsyncStream<CloudSyncUpdate>.Continuation) {
        self.containerIdentifier = containerIdentifier
        self.host = host
        self.updates = updates
    }

    /// 开始旁听系统事件（要在打开数据库之前调用：打开时的第一次设置与导入也要收到）；事件按发出的顺序排进返回的队列
    static func observeEvents() -> AsyncStream<Event> {
        let (events, continuation) = AsyncStream.makeStream(of: Event.self)
        _ = NotificationCenter.default.addObserver(forName: NSPersistentCloudKitContainer.eventChangedNotification, object: nil, queue: nil) { notification in
            guard let event = notification.userInfo?[NSPersistentCloudKitContainer.eventNotificationUserInfoKey] as? NSPersistentCloudKitContainer.Event,
                  let value = Event(event) else { return }
            continuation.yield(value)
        }
        return events
    }

    /// 逐个处理事件；iCloud 账户变了（登录、退出、换账户）重新检查账户状态并合并一次
    nonisolated func start(_ events: AsyncStream<Event>) {
        _ = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: nil) { [weak self] _ in
            Task { await self?.accountChanged() }
        }
        Task {
            await refreshAccountStatus()
            for await event in events {
                await handle(event)
            }
        }
    }

    /// 同步库没接上 iCloud、本次以不同步方式运行：设置里显示原因（StoreHost 打开后告知）
    func cloudDisabled(_ reason: String) {
        disabledReason = reason
        publish()
    }

    // MARK: - 处理

    private func handle(_ event: Event) {
        if event.isFinished {
            running.remove(event.id)
            if event.succeeded {
                failures[event.kind] = nil
                if event.kind != .setup {
                    let date = event.endDate ?? .now
                    status.lastSyncedAt = date
                    UserDefaults.standard.set(date, forKey: Self.lastSyncedKey)
                }
            } else {
                failures[event.kind] = event.problem
            }
            // 导入（以及账户变化后系统清掉、重建同步库）可能改了数据：合并去重、更新索引，有变化再让界面重读
            if event.kind != .export { requestMerge() }
        } else if event.kind != .setup {
            running.insert(event.id)
        }
        status.isSyncing = !running.isEmpty
        publish()
    }

    /// 排一次合并：正在合并就只记一笔，合并完再跑一次
    private func requestMerge(notify: Bool = false) {
        mergeRequested = true
        if notify { notifyAfterMerge = true }
        guard !merging else { return }
        merging = true
        // 合并是后台活，但与界面的调用同级（userInitiated，原因见 QueueModelExecutor）
        Task(priority: .userInitiated) { await runMerges() }
    }

    private func runMerges() async {
        while mergeRequested {
            mergeRequested = false
            let notify = notifyAfterMerge
            notifyAfterMerge = false
            var changed = false
            if let store = try? await host.store() {
                // 合并去重在 CloudWorker 上做，写入 actor 只做本机那一半（见 ClipStore.syncFromCloud）
                changed = await store.syncFromCloud()
            }
            if changed || notify { updates.yield(.dataChanged) }
        }
        merging = false
    }

    private func accountChanged() async {
        await refreshAccountStatus()
        // 退出或换账户时系统会清掉同步库的本机数据：等它清完再合并（索引、History 的对齐跟着更新），并让界面重读
        try? await Task.sleep(for: Self.accountChangeDelay)
        requestMerge(notify: true)
    }

    private func refreshAccountStatus() async {
        do {
            switch try await CKContainer(identifier: containerIdentifier).accountStatus() {
            case .noAccount, .restricted: accountProblem = .notSignedIn
            case .temporarilyUnavailable: accountProblem = .accountUnavailable
            default: accountProblem = nil
            }
        } catch {
            // 查不到账户状态不算问题，以同步事件为准
            accountProblem = nil
        }
        publish()
    }

    private func publish() {
        var current = status
        if let disabledReason {
            current.isSyncing = false
            current.problem = .other(disabledReason)
        } else {
            current.problem = accountProblem ?? failures[.export] ?? failures[.import] ?? failures[.setup]
        }
        updates.yield(.status(current))
    }

    /// 系统错误 → 设置里看得懂的原因
    static func problem(for error: any Error) -> CloudSyncStatus.Problem {
        let nsError = error as NSError
        if nsError.domain == CKError.errorDomain {
            switch CKError.Code(rawValue: nsError.code) {
            case .notAuthenticated:
                return .notSignedIn
            case .quotaExceeded:
                return .quotaExceeded
            case .networkUnavailable, .networkFailure, .serviceUnavailable, .requestRateLimited, .zoneBusy:
                return .networkUnavailable
            case .partialFailure:
                if let first = (nsError.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: any Error])?.values.first {
                    return problem(for: first)
                }
            default:
                break
            }
        }
        // 134400：这台 Mac 没有可用的 iCloud 账户
        if nsError.domain == NSCocoaErrorDomain, nsError.code == 134400 {
            return .notSignedIn
        }
        // Core Data 把 CloudKit 的错误包在里面
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? any Error {
            return problem(for: underlying)
        }
        return .other(nsError.localizedDescription)
    }
}

extension CloudSyncMonitor.Event {
    init?(_ event: NSPersistentCloudKitContainer.Event) {
        let kind: Kind
        switch event.type {
        case .setup: kind = .setup
        case .import: kind = .import
        case .export: kind = .export
        @unknown default: return nil
        }
        self.init(
            id: event.identifier,
            kind: kind,
            isFinished: event.endDate != nil,
            succeeded: event.succeeded,
            endDate: event.endDate,
            problem: event.error.map(CloudSyncMonitor.problem(for:))
        )
    }
}
