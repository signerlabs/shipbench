import SwiftUI

struct Habit: Identifiable, Hashable {
    let id: String
    var name: String
    /// One of the keys in `Habit.palette`.
    var colorName: String
    var reminderTime: Date?

    var color: Color { Habit.palette[colorName] ?? .green }

    static let palette: [String: Color] = [
        "green": .green, "blue": .blue, "orange": .orange, "pink": .pink, "purple": .purple,
    ]
}
