import Foundation

/// One fitness expense, as returned by the server.
struct Expense: Identifiable, Hashable, Codable {
    let id: String
    /// Amount in the user's local currency.
    var amount: Decimal
    /// The day the money was spent, exactly as the server stores it: a plain calendar date such as "2026-11-20"
    /// (no time of day, no time zone).
    var date: String
    var note: String
}
