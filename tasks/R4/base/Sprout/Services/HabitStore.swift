import Foundation
import Observation

enum HabitStoreError: LocalizedError {
    case emptyName
    case network

    var errorDescription: String? {
        switch self {
        case .emptyName: "Name can't be empty."
        case .network: "Network error. Please try again."
        }
    }
}

@Observable
final class HabitStore {
    static let shared = HabitStore()

    private(set) var habits: [Habit] = []
    private(set) var isLoading = false

    /// Loads the user's habits from the server.
    func load() async throws {
        isLoading = true
        defer { isLoading = false }
        try await Task.sleep(for: .milliseconds(400)) // simulated network latency
        habits = [
            Habit(id: "h1", name: "Drink water", colorName: "blue", reminderTime: nil),
            Habit(id: "h2", name: "Morning run", colorName: "green", reminderTime: nil),
            Habit(id: "h3", name: "Read 20 pages", colorName: "orange", reminderTime: nil),
        ]
    }

    /// Saves a habit to the server. Throws `HabitStoreError` on failure.
    func save(_ habit: Habit) async throws {
        try await Task.sleep(for: .milliseconds(400)) // simulated network latency
        if habit.name.trimmingCharacters(in: .whitespaces).isEmpty { throw HabitStoreError.emptyName }
        if let index = habits.firstIndex(where: { $0.id == habit.id }) { habits[index] = habit }
    }
}
