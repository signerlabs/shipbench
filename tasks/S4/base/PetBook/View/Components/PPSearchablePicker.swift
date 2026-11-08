//
//  PPSearchablePicker.swift
//  PetBook
//
//  通用 searchable 单选 picker：折叠态是一行 field（显示当前选择 / 占位 + 上下箭头），
//  点击拉起带 .searchable 搜索框的全屏 sheet，输入即过滤，点选即回写 selection 并关闭。
//
//  rowAccessory 闭包为每一行尾部插入可选附件（如狗品种的 HDB 合规徽章）；
//  不需要附件时传 { _ in EmptyView() }（如猫品种）。
//

import SwiftUI

struct PPSearchablePicker<Accessory: View, Trigger: View>: View {
    let placeholder: LocalizedStringKey
    let sheetTitle: LocalizedStringKey
    var searchPrompt: LocalizedStringKey = "Search"
    @Binding var selection: String
    let options: [String]
    @ViewBuilder var rowAccessory: (String) -> Accessory
    private let customTrigger: ((@escaping () -> Void) -> Trigger)?

    @State private var showSheet = false
    @State private var query = ""

    init(
        placeholder: LocalizedStringKey,
        sheetTitle: LocalizedStringKey,
        searchPrompt: LocalizedStringKey = "Search",
        selection: Binding<String>,
        options: [String],
        @ViewBuilder rowAccessory: @escaping (String) -> Accessory
    ) where Trigger == EmptyView {
        self.placeholder = placeholder
        self.sheetTitle = sheetTitle
        self.searchPrompt = searchPrompt
        self._selection = selection
        self.options = options
        self.rowAccessory = rowAccessory
        self.customTrigger = nil
    }

    init(
        placeholder: LocalizedStringKey,
        sheetTitle: LocalizedStringKey,
        searchPrompt: LocalizedStringKey = "Search",
        selection: Binding<String>,
        options: [String],
        @ViewBuilder rowAccessory: @escaping (String) -> Accessory,
        @ViewBuilder trigger: @escaping (@escaping () -> Void) -> Trigger
    ) {
        self.placeholder = placeholder
        self.sheetTitle = sheetTitle
        self.searchPrompt = searchPrompt
        self._selection = selection
        self.options = options
        self.rowAccessory = rowAccessory
        self.customTrigger = trigger
    }

    private var filtered: [String] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return options }
        return options.filter { $0.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        Group {
            if let customTrigger {
                customTrigger { showSheet = true }
            } else {
                Button {
                    showSheet = true
                } label: {
                    HStack {
                        (selection.isEmpty ? Text(placeholder) : Text(selection))
                            .foregroundStyle(selection.isEmpty ? Color.ppTextSecondary : Color.ppTextPrimary)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showSheet) {
            sheet
        }
    }

    private var sheet: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filtered, id: \.self) { option in
                        Button {
                            selection = option
                            showSheet = false
                        } label: {
                            HStack(spacing: PPSpacing.md) {
                                Text(option)
                                    .font(.body)
                                    .foregroundStyle(Color.ppTextPrimary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                rowAccessory(option)
                                if option == selection {
                                    Image(systemName: "checkmark")
                                        .font(.footnote)
                                        .fontWeight(.semibold)
                                        .foregroundStyle(Color.ppPrimary)
                                }
                            }
                            .padding(.vertical, 14)
                            .padding(.horizontal, PPSpacing.xl)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        Divider()
                            .padding(.leading, PPSpacing.xl)
                    }

                    if filtered.isEmpty {
                        Text("No matches")
                            .font(.footnote)
                            .foregroundStyle(Color.ppTextSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, PPSpacing.xxl)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.ppBackground)
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle(sheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text(searchPrompt)
            )
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSheet = false } label: {
                        Image(systemName: "checkmark")
                    }
                }
            }
        }
    }
}

#Preview("Dog breed") {
    @Previewable @State var breed = ""
    PPLabeledField(label: "Breed", hint: "Used for HDB compliance check") {
        PPSearchablePicker(
            placeholder: "Select breed",
            sheetTitle: "Select Dog Breed",
            searchPrompt: "Search breeds",
            selection: $breed,
            options: BreedCatalog.dogBreedNames
        ) { name in
            if let status = BreedCatalog.dogStatus(for: name) {
                HDBComplianceBadge(status: status)
            }
        }
    }
    .padding(24)
    .background(Color.ppBackground)
}
