import Foundation

/// Talks to the goal endpoints. Stubbed with in-memory data for now.
final class GoalAPI {
    static let shared = GoalAPI()

    private let goals: [Goal]

    private init() {
        goals = [
            Goal(id: "g1", title: "Run 30 km this month", dueDate: Self.dayString(daysFromNow: -3)),
            Goal(id: "g2", title: "Finish \"Atomic Habits\"", dueDate: Self.dayString(daysFromNow: 0)),
            Goal(id: "g3", title: "Drink water 14 days in a row", dueDate: Self.dayString(daysFromNow: 2)),
            Goal(id: "g4", title: "Meditate 20 times", dueDate: Self.dayString(daysFromNow: 10)),
        ]
    }

    /// Fetches the user's goals, soonest due first. `dueDate` is a plain "yyyy-MM-dd" string.
    func fetch() async throws -> [Goal] {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        return goals.sorted { $0.dueDate < $1.dueDate }
    }

    /// Calendar day for the stub data (the real server stores the user's local day).
    private static func dayString(daysFromNow: Int) -> String {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: daysFromNow, to: .now) ?? .now
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
