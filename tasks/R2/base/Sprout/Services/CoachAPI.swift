import Foundation

/// Talks to the AI coach. Stubbed: streams a canned answer for now.
final class CoachAPI {
    static let shared = CoachAPI()

    /// Streams the coach's reply to `message` a few characters at a time, as the model writes it.
    /// The reply is Markdown (headings, lists, **bold**, `code`). The stream throws if the connection drops.
    func streamReply(to message: String) -> AsyncThrowingStream<String, Error> {
        let reply = Self.cannedReply
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var index = reply.startIndex
                    while index < reply.endIndex {
                        try await Task.sleep(for: .milliseconds(25)) // simulated generation speed
                        let end = reply.index(index, offsetBy: 3, limitedBy: reply.endIndex) ?? reply.endIndex
                        continuation.yield(String(reply[index..<end]))
                        index = end
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static let cannedReply = """
    ### Nice work this week!

    You checked in **5 of 7 days**. Here's a plan for tomorrow:

    1. Drink a glass of water right after you wake up.
    2. Go for a *10-minute* run before breakfast.
    3. Read 20 pages before bed.

    - Keep your phone in another room while you read.
    - Tick each habit off in Sprout as soon as it's done.

    Tip: set the reminder with `Morning run` at **7:00**.
    """
}
