import SwiftUI

struct HabitListView: View {
    @State private var store = HabitStore.shared

    var body: some View {
        NavigationStack {
            List(store.habits) { habit in
                HStack(spacing: 12) {
                    Circle().fill(habit.color).frame(width: 12, height: 12)
                    Text(habit.name)
                    Spacer()
                    if let time = habit.reminderTime {
                        Text(time, style: .time).foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if store.isLoading && store.habits.isEmpty { ProgressView() }
            }
            .navigationTitle("Habits")
            .task { try? await store.load() }
        }
    }
}
