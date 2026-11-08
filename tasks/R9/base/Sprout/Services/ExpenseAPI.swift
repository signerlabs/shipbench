import Foundation

enum ExpenseAPIError: LocalizedError {
    case invalidAmount
    case network

    var errorDescription: String? {
        switch self {
        case .invalidAmount: "Amount must be greater than zero."
        case .network: "Network error. Please try again."
        }
    }
}

/// Talks to the expense endpoints. Stubbed with in-memory data for now.
final class ExpenseAPI {
    static let shared = ExpenseAPI()

    private var expenses: [Expense]

    private init() {
        expenses = [
            Expense(id: "e1", amount: 12.5, date: Self.dayString(daysAgo: 0), note: "Protein bars"),
            Expense(id: "e2", amount: 64.9, date: Self.dayString(daysAgo: 2), note: "Running shoes (sale)"),
            Expense(id: "e3", amount: 8, date: Self.dayString(daysAgo: 5), note: "Pool entry"),
            Expense(id: "e4", amount: 120, date: Self.dayString(daysAgo: 9), note: "Gym membership"),
        ]
    }

    /// Fetches the user's expenses, newest first. `date` is a plain "yyyy-MM-dd" string.
    func fetch() async throws -> [Expense] {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        return expenses.sorted { $0.date > $1.date }
    }

    /// Saves a new expense. Throws `ExpenseAPIError.invalidAmount` when the amount is not greater than zero.
    func add(_ expense: Expense) async throws {
        try await Task.sleep(for: .milliseconds(300)) // simulated network latency
        guard expense.amount > 0 else { throw ExpenseAPIError.invalidAmount }
        expenses.append(expense)
    }

    /// Calendar day for the stub data (the real server stores the user's local day).
    private static func dayString(daysAgo: Int) -> String {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: -daysAgo, to: .now) ?? .now
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
