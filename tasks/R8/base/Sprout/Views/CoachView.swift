import SwiftUI

/// Coach screen (placeholder for now).
struct CoachView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView("Coach", systemImage: "bubble.left", description: Text("Chat with your habit coach here."))
                .navigationTitle("Coach")
        }
    }
}
