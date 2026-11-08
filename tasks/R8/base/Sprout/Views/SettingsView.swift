import SwiftUI

/// Settings screen (placeholder for now).
struct SettingsView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView("Settings", systemImage: "gearshape", description: Text("Account and app settings go here."))
                .navigationTitle("Settings")
        }
    }
}
