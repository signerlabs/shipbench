import Foundation
import Observation

enum AuthError: LocalizedError {
    case network

    var errorDescription: String? {
        switch self {
        case .network: "Network error. Please try again."
        }
    }
}

/// Who is signed in. Stubbed: the account lives on a fake server for now.
@Observable
final class AuthStore {
    static let shared = AuthStore()

    /// Whether a user is signed in. The app starts signed in.
    private(set) var isSignedIn = true

    /// Signs in. Stub: always succeeds.
    func signIn() async throws {
        try await Task.sleep(for: .milliseconds(400)) // simulated network latency
        isSignedIn = true
    }

    /// Signs out on this device: forgets the session.
    func signOut() {
        isSignedIn = false
    }

    /// Permanently deletes the account and all of its data on the server, then signs out.
    /// Throws `AuthError.network` when the server can't be reached.
    func deleteAccount() async throws {
        try await Task.sleep(for: .milliseconds(800)) // simulated network latency
        isSignedIn = false
    }
}
