import SwiftUI

/// Stats screen (placeholder for now).
struct StatsView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView("Stats", systemImage: "chart.bar", description: Text("Your weekly progress will show up here."))
                .navigationTitle("Stats")
        }
    }
}
