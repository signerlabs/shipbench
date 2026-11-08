import Foundation

/// A logged meal.
struct Meal: Identifiable, Hashable {
    let id: String
    var name: String
    var eatenAt: Date
}
