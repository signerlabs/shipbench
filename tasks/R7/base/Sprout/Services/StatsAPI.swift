import Foundation

/// This week's headline numbers next to last week's, for the stats page.
struct StatsSummary: Hashable {
    /// Share of planned check-ins done, 0...1.
    var completionRate: Double
    var lastWeekCompletionRate: Double
    /// Current streak, in days.
    var currentStreak: Int
    var lastWeekCurrentStreak: Int
    /// Check-ins ever made.
    var totalCheckIns: Int
    var lastWeekTotalCheckIns: Int
    /// Longest streak ever, in days.
    var longestStreak: Int
    var lastWeekLongestStreak: Int
}

/// Check-ins made on one calendar day.
struct DayCount: Hashable {
    /// Start of the day, in the user's time zone.
    var day: Date
    var count: Int
}

/// Talks to the stats endpoints. Stubbed with generated data for now.
final class StatsAPI {
    static let shared = StatsAPI()

    /// Every check-in of the last 120 days, one timestamp per check-in.
    private let history: [Date]

    private init() {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        var dates: [Date] = []
        for daysAgo in 0..<120 where daysAgo % 7 != 3 && daysAgo % 11 != 5 {
            let day = calendar.date(byAdding: .day, value: -daysAgo, to: today) ?? today
            for slot in 0..<(1 + (daysAgo * 5) % 3) {
                dates.append(day.addingTimeInterval(Double(8 + slot * 5) * 3600))
            }
        }
        history = dates
    }

    func summary() async throws -> StatsSummary {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        return StatsSummary(
            completionRate: 0.82, lastWeekCompletionRate: 0.74,
            currentStreak: 3, lastWeekCurrentStreak: 6,
            totalCheckIns: history.count, lastWeekTotalCheckIns: history.count - 14,
            longestStreak: 9, lastWeekLongestStreak: 9
        )
    }

    /// Check-ins per day for the last 7 days, oldest first.
    func lastSevenDays() async throws -> [DayCount] {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        return (0..<7).reversed().map { daysAgo in
            let day = calendar.date(byAdding: .day, value: -daysAgo, to: today) ?? today
            return DayCount(day: day, count: history.filter { calendar.isDate($0, inSameDayAs: day) }.count)
        }
    }

    /// Every check-in of the last 120 days, one timestamp per check-in.
    func checkIns() async throws -> [Date] {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        return history
    }
}
