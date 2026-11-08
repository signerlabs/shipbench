import SwiftUI

@main
struct SproutApp: App {
    var body: some Scene {
        WindowGroup {
            HabitListView()
                .swAlert()
        }
    }
}
