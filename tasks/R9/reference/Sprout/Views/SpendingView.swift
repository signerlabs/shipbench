import SwiftUI

struct SpendingView: View {
    @State private var expenses: [Expense] = []
    @State private var showAddSheet = false

    /// 币种跟用户所在地区走（美国 USD、德法 EUR）
    private var currencyCode: String { Locale.current.currency?.identifier ?? "USD" }

    private var monthTotal: Decimal {
        let calendar = Calendar.current
        return expenses
            .filter { expense in
                guard let day = ExpenseDay.date(from: expense.date) else { return false }
                return calendar.isDate(day, equalTo: .now, toGranularity: .month)
            }
            .reduce(0) { $0 + $1.amount }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("This month")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(monthTotal, format: .currency(code: currencyCode))
                        .font(.largeTitle.bold())
                        .contentTransition(.numericText())
                }
            }
            Section {
                ForEach(expenses) { expense in
                    row(expense)
                }
            }
        }
        .navigationTitle("Spending")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add expense")
            }
        }
        .sheet(isPresented: $showAddSheet) {
            SWAddSheet(isPresented: $showAddSheet, title: "Today's spending", placeHolderText: "Amount", minLines: 1) { text in
                Task { await add(text) }
            }
        }
        .task { await load() }
    }

    private func row(_ expense: Expense) -> some View {
        let day = ExpenseDay.date(from: expense.date)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(expense.note)
                if let day {
                    Text(day, format: .dateTime.month(.abbreviated).day())
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let day, Calendar.current.isDateInToday(day) {
                SWStatusBadge(text: "Today", style: .info)
            }
            if expense.amount > 50 {
                SWStatusBadge(text: "Large", style: .error)
            }
            Text(expense.amount, format: .currency(code: currencyCode))
                .monospacedDigit()
        }
    }

    private func load() async {
        do {
            expenses = try await ExpenseAPI.shared.fetch()
        } catch {
            SWAlertManager.shared.show(.error, message: error.localizedDescription)
        }
    }

    private func add(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // 按当前地区解析：德、法用户输入的是 19,99
        guard let amount = try? Decimal(trimmed, format: .number), amount > 0 else {
            SWAlertManager.shared.show(.error, message: "Enter a valid amount.")
            return
        }
        let expense = Expense(id: UUID().uuidString, amount: amount, date: ExpenseDay.string(from: .now), note: "")
        do {
            try await ExpenseAPI.shared.add(expense)
            expenses = try await ExpenseAPI.shared.fetch()
            SWAlertManager.shared.show(.success, message: "Logged")
        } catch {
            SWAlertManager.shared.show(.error, message: error.localizedDescription)
        }
    }
}

/// 服务器的纯日期 "yyyy-MM-dd"：按当地时区的正午解析，按当地时区显示
enum ExpenseDay {
    static func date(from string: String) -> Date? {
        let parts = string.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    static func string(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
