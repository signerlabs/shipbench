import Foundation

/// A goal with a due day, as returned by the server.
struct Goal: Identifiable, Hashable, Codable {
    let id: String
    var title: String
    /// The day the goal is due, exactly as the server stores it: a plain calendar date such as "2026-11-20"
    /// (no time of day, no time zone).
    var dueDate: String
}
