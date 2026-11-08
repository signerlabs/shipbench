import Foundation

enum MealAPIError: LocalizedError {
    case emptyName
    case network

    var errorDescription: String? {
        switch self {
        case .emptyName: "Tell us what you ate."
        case .network: "Network error. Please try again."
        }
    }
}

/// Talks to the meal endpoints. Stubbed with in-memory data for now.
final class MealAPI {
    static let shared = MealAPI()

    private(set) var meals: [Meal] = []
    private var photos: [String: Data] = [:]

    /// Saves a meal together with its photo (JPEG data, or nil when there is no photo).
    /// Throws `MealAPIError.emptyName` when the name is empty.
    func save(_ meal: Meal, photo: Data?) async throws {
        try await Task.sleep(for: .milliseconds(400)) // simulated network latency
        guard !meal.name.trimmingCharacters(in: .whitespaces).isEmpty else { throw MealAPIError.emptyName }
        meals.append(meal)
        photos[meal.id] = photo
    }
}
