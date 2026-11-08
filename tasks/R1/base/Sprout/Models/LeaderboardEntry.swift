import Foundation

/// One row of the friends leaderboard, exactly as `GET /v1/leaderboard` returns it.
struct LeaderboardEntry: Decodable, Hashable {
    /// The friend's user id: unique and never changes.
    let userId: String
    let name: String
    /// Profile photo. `nil` when the friend has not uploaded one.
    let avatarURL: URL?
    /// Current check-in streak, in days.
    let streakDays: Int
}
