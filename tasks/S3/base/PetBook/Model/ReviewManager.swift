//
//  ReviewManager.swift
//  PetBook
//
//  主动请求 App Store 评分（StoreKit）。参考另一个 App：节流 + 绑定正向操作，不打扰用户。
//  策略：app 启动 ≥2 次 或 完成 ≥3 次有意义操作（看诊所名片 / 加宠物 / 加健康记录）任一满足，
//        且 距上次请求 ≥60 天 → 延迟 1 秒调系统 requestReview（一年最多 3 次由系统兜底）。
//  系统弹窗本身合规、不可定制；这里只控制「何时值得请求」。手动「Rate」入口在 ProfileView。
//

import StoreKit
import UIKit

@MainActor
final class ReviewManager {
    static let shared = ReviewManager()
    private init() {}

    private enum Config {
        static let minLaunches = 2            // 至少启动过 2 次
        static let minActions = 3             // 至少完成 3 次正向操作
        static let daysBetweenRequests = 60   // 两次请求间隔 ≥60 天
        static let delay: Duration = .seconds(1)
    }

    private enum Key {
        static let launches = "review.launchCount"
        static let actions = "review.actionCount"
        static let lastRequest = "review.lastRequestDate"
    }

    private let defaults = UserDefaults.standard

    /// App 每次启动调用一次（入口 `.task`）。启动够多本身即可触发（OR 条件之一）。
    func recordLaunch() {
        defaults.set(defaults.integer(forKey: Key.launches) + 1, forKey: Key.launches)
        maybeRequestReview()
    }

    /// 用户完成一次有意义的正向操作时调用（看诊所名片 / 加宠物 / 加健康记录）。
    func recordMeaningfulAction() {
        defaults.set(defaults.integer(forKey: Key.actions) + 1, forKey: Key.actions)
        maybeRequestReview()
    }

    /// 满足「任一」条件（启动 ≥ minLaunches 或 正向操作 ≥ minActions）且不在冷却期 → 请求评分。
    private func maybeRequestReview() {
        guard defaults.integer(forKey: Key.launches) >= Config.minLaunches
                || defaults.integer(forKey: Key.actions) >= Config.minActions,
              !isInCooldown()
        else { return }

        Task {
            try? await Task.sleep(for: Config.delay)
            requestReview()
        }
    }

    private func isInCooldown() -> Bool {
        guard let last = defaults.object(forKey: Key.lastRequest) as? Date else { return false }
        let days = Calendar.current.dateComponents([.day], from: last, to: .now).day ?? 0
        return days < Config.daysBetweenRequests
    }

    private func requestReview() {
        guard let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        else { return }
        AppStore.requestReview(in: scene)
        defaults.set(Date(), forKey: Key.lastRequest)
    }
}
