import SwiftUI

/// "Log a meal" form.
struct MealLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var eatenAt = Date.now
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                TextField("What did you eat?", text: $name)
                DatePicker("Time", selection: $eatenAt)
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Log a Meal")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }
                    .disabled(isSaving)
            }
        }
    }

    private func save() {
        isSaving = true
        errorMessage = nil
        let meal = Meal(id: UUID().uuidString, name: name, eatenAt: eatenAt)
        Task {
            defer { isSaving = false }
            do {
                try await MealAPI.shared.save(meal, photo: nil)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
