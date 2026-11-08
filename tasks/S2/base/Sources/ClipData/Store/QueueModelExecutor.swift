//
//  QueueModelExecutor.swift
//  ClipData
//
//  数据层 actor（ClipStore、CloudWorker）的执行器：各用一条自己的串行队列，调用排进队列异步执行。
//  不用 SwiftData 自带的 DefaultSerialModelExecutor：它在调用方的线程上同步执行（performAndWait），一个 actor 调另一个
//  会嵌套在同一线程上、前一个一直被占着——CloudWorker 等 iCloud 镜像时 ClipStore 也跟着卡住，界面的调用只能排在后面；
//  等的时候 Swift 并发的线程池也被占着。换成队列后排队交给 GCD，高优先级的调用排进来，队列正在跑的活随之提升。
//  优先级：数据层的活（含合并、维护、修补索引这些后台活）一律 userInitiated，与界面的调用同级。Core Data 取库连接靠信号量，
//  系统不会把占着连接的低优先级线程提上来：后台活用 utility 的话，界面的调用碰上它占着连接就得干等，Xcode 报 Hang Risk
//  （2026-10-11 实测：后台用 utility 每次启动报 1–2 条，统一成 userInitiated 后连续 7 次启动零条）。
//  ModelContext 仍须在主线程之外创建（在主线程创建的会绑在主队列上）。
//

import Dispatch
import SwiftData

final class QueueModelExecutor: SerialModelExecutor, @unchecked Sendable {
    let modelContext: ModelContext
    private let queue: DispatchSerialQueue

    init(modelContext: ModelContext, label: String) {
        self.modelContext = modelContext
        // 每个任务自带一个 autorelease pool（Core Data 会产生大量临时对象）
        queue = DispatchSerialQueue(label: label, autoreleaseFrequency: .workItem)
    }

    func enqueue(_ job: consuming ExecutorJob) {
        queue.enqueue(job)
    }

    /// actor 的执行器就是这条队列本身（任务的优先级与提升由 GCD 处理）
    func asUnownedSerialExecutor() -> UnownedSerialExecutor {
        queue.asUnownedSerialExecutor()
    }
}
