import SwiftUI

struct SpendingView: View {
    @State private var expenses: [Expense] = []
    @State private var showAdd = false
    @State private var amountText = ""
    @State private var toast: String?
    @State private var showError = false
    @State private var errorMessage = ""

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private var total: Double {
        expenses.reduce(0) { $0 + NSDecimalNumber(decimal: $1.amount).doubleValue }
    }

    var body: some View {
        ZStack(alignment: .top) {
            List {
                Text("This month: $\(String(format: "%.2f", total))")
                    .font(.title.bold())
                ForEach(expenses) { expense in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(expense.note)
                            if let day = Self.dayFormatter.date(from: expense.date) {
                                Text(day.formatted(date: .abbreviated, time: .omitted)).font(.caption)
                            }
                        }
                        Spacer()
                        if expense.date == Self.dayFormatter.string(from: .now) {
                            Text("Today")
                                .font(.caption)
                                .padding(.horizontal, 8)
                                .background(Capsule().fill(.blue.opacity(0.2)))
                        }
                        if expense.amount > 50 {
                            Text("Large")
                                .font(.caption)
                                .foregroundStyle(.red)
                                .padding(.horizontal, 8)
                                .background(Capsule().fill(.red.opacity(0.2)))
                        }
                        Text("$\(NSDecimalNumber(decimal: expense.amount).doubleValue, specifier: "%.2f")")
                    }
                }
            }
            if let toast {
                ToastBanner(text: toast)
            }
        }
        .navigationTitle("Spending")
        .toolbar {
            Button { showAdd = true } label: { Image(systemName: "plus") }
        }
        .sheet(isPresented: $showAdd) {
            VStack(spacing: 16) {
                TextField("Amount", text: $amountText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                Button("Save") { save() }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
            .presentationDetents([.medium])
        }
        .alert("Error", isPresented: $showError) {
            Button("OK") {}
        } message: {
            Text(errorMessage)
        }
        .task {
            expenses = (try? await ExpenseAPI.shared.fetch()) ?? []
        }
    }

    private func save() {
        guard let value = Double(amountText) else {
            errorMessage = "Please enter a number."
            showError = true
            return
        }
        let expense = Expense(id: UUID().uuidString, amount: Decimal(value), date: Self.dayFormatter.string(from: .now), note: "")
        showAdd = false
        Task {
            do {
                try await ExpenseAPI.shared.add(expense)
                expenses = try await ExpenseAPI.shared.fetch()
                // 等 sheet 收起再出提示
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    toast = "Logged"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { toast = nil }
                }
            } catch {
                errorMessage = error.localizedDescription
                showError = true
            }
        }
    }
}

struct ToastBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.thinMaterial, in: Capsule())
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}
