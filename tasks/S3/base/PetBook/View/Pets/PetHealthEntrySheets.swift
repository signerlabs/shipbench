//
//  PetHealthEntrySheets.swift
//  PetBook
//
//  PetDetailView 的两个健康记录录入 sheet：
//    • AddVaccinationSheet — 疫苗类型 / 接种日期 / 下次到期(可选) / 品牌
//    • AddWeightSheet      — 体重(kg) / 记录日期
//  提交写入 store，dismiss + toast 反馈。骨架阶段无校验，纯 mock 内存写入。
//

import SwiftUI

// MARK: - 宠物 context header（三个录入 sheet 共用，设计语言 v2 · P4 对象感）

/// Form 第一段 header：小头像 + "For Mochi"，让每次录入都有明确对象。
/// pet 为 nil（petID 找不到，理论少见）时不占位。
private struct PetContextHeader: View {
    let pet: Pet?

    var body: some View {
        if let pet {
            HStack(spacing: PPSpacing.sm) {
                PPPetAvatar(pet: pet, size: 24)
                Text("For \(pet.name)")
            }
            .font(.footnote)
            .foregroundStyle(Color.ppTextSecondary)
            .textCase(nil)
            .padding(.bottom, PPSpacing.xs)
        }
    }
}

// MARK: - 疫苗录入

struct AddVaccinationSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let petID: UUID
    private let existing: VaccinationRecord?   // nil = 新增；非 nil = 编辑（左滑 Edit 进入，预填 + 走 update）

    private var pet: Pet? { store.pets.first { $0.id == petID } }

    /// 新增模式保存按钮带宠物名（"Save for Mochi"），编辑模式维持动作语义。
    private var saveTitle: LocalizedStringKey {
        if existing != nil { return "Update vaccine" }
        if let pet { return "Save for \(pet.name)" }
        return "Save vaccine"
    }

    @State private var vaccineType: VaccineType
    @State private var administeredDate: Date
    @State private var hasNextDue: Bool
    @State private var nextDueDate: Date
    @State private var brand: String

    init(petID: UUID, existing: VaccinationRecord? = nil) {
        self.petID = petID
        self.existing = existing
        _vaccineType = State(initialValue: existing?.vaccineType ?? .dhppl)
        _administeredDate = State(initialValue: existing?.administeredDate ?? Date())
        _hasNextDue = State(initialValue: existing.map { $0.nextDueDate != nil } ?? true)
        _nextDueDate = State(initialValue: existing?.nextDueDate
            ?? Calendar.current.date(byAdding: .year, value: 1, to: Date()) ?? Date())
        _brand = State(initialValue: existing?.brand ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Vaccine type", selection: $vaccineType) {
                        ForEach(VaccineType.allCases) { type in
                            Text(type.rawValue).tag(type)
                        }
                    }
                    DatePicker("Date given", selection: $administeredDate, displayedComponents: .date)
                } header: {
                    PetContextHeader(pet: pet)
                }
                .listRowBackground(Color.ppSurface)

                Section {
                    Toggle("Set next due date", isOn: $hasNextDue)
                        .tint(Color.ppPrimary)
                    if hasNextDue {
                        DatePicker("Next due date", selection: $nextDueDate, displayedComponents: .date)
                    }
                } header: {
                    Text("When the next dose is recommended")
                }
                .listRowBackground(Color.ppSurface)

                Section {
                    LabeledContent("Brand") {
                        TextField("E.g. Nobivac", text: $brand)
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text("Optional")
                }
                .listRowBackground(Color.ppSurface)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollContentBackground(.hidden)
            .background(Color.ppBackground)
            .navigationTitle(existing == nil ? "Add vaccine" : "Edit vaccine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .tint(Color.ppTextSecondary)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: PPSpacing.lg) {
                    PPPrimaryButton(title: saveTitle) {
                        save()
                    }
                    .shadow(radius: 10)
                    // 编辑模式才有删除入口
                    if let r = existing {
                        Button(role: .destructive) {
                            store.deleteVaccination(r)
                            dismiss()
                            SWAlertManager.shared.show(.success, message: "Vaccine deleted")
                        } label: {
                            Text("Delete record")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundStyle(Color.ppDanger)
                        }
                    }
                }
                .padding(.horizontal, PPSpacing.xxxl)
            }
        }
    }

    private func save() {
        let trimmedBrand = brand.trimmingCharacters(in: .whitespaces)
        if var r = existing {
            // 编辑：保留 id + 不可编辑字段（batchNo / vetClinicID / notes），只改本 sheet 字段
            r.vaccineType = vaccineType
            r.administeredDate = administeredDate
            r.nextDueDate = hasNextDue ? nextDueDate : nil
            r.brand = trimmedBrand.isEmpty ? nil : trimmedBrand
            store.updateVaccination(r)
            SWAlertManager.shared.show(.success, message: "Vaccine updated")
        } else {
            let record = VaccinationRecord(
                petID: petID,
                vaccineType: vaccineType,
                administeredDate: administeredDate,
                nextDueDate: hasNextDue ? nextDueDate : nil,
                brand: trimmedBrand.isEmpty ? nil : trimmedBrand
            )
            store.addVaccination(record)
            SWAlertManager.shared.show(.success, message: "Vaccine added")
        }
        dismiss()
    }
}

// MARK: - 体重录入

struct AddWeightSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let petID: UUID

    @State private var weightText = ""
    @State private var recordedDate = Date()

    private var pet: Pet? { store.pets.first { $0.id == petID } }

    private var saveTitle: LocalizedStringKey {
        if let pet { return "Save for \(pet.name)" }
        return "Save weight"
    }

    /// 解析输入（支持小数），非法 / 空 / ≤0 时不可保存
    private var parsedWeight: Double? {
        guard let v = Double(weightText.replacingOccurrences(of: ",", with: ".")), v > 0 else { return nil }
        return v
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Weight (kg)") {
                        TextField("e.g. 4.2", text: $weightText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    DatePicker("Date", selection: $recordedDate, displayedComponents: .date)
                } header: {
                    PetContextHeader(pet: pet)
                }
                .listRowBackground(Color.ppSurface)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollContentBackground(.hidden)
            .background(Color.ppBackground)
            .navigationTitle("Add weight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .tint(Color.ppTextSecondary)
                }
            }
            .safeAreaInset(edge: .bottom) {
                PPPrimaryButton(title: saveTitle, enabled: parsedWeight != nil) {
                    save()
                }
                .shadow(radius: 10)
                .padding(.horizontal, PPSpacing.xxxl)
            }
        }
    }

    private func save() {
        guard let kg = parsedWeight else { return }
        let record = WeightRecord(petID: petID, recordedDate: recordedDate, weightKg: kg)
        store.addWeightRecord(record)
        dismiss()
        SWAlertManager.shared.show(.success, message: "Weight added")
    }
}

// MARK: - 驱虫录入

/// 驱虫记录录入 sheet（照 AddVaccinationSheet 模板）。
/// 字段：kind（三选一 picker，必填）/ administeredDate（必填）/ nextDueDate（可选 toggle）
///       / productName（可选）/ notes（可选多行）。保存走 store.addDeworming(_:) → 后端 POST 落库。
struct AddDewormingSheet: View {
    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let petID: UUID
    private let existing: DewormingRecord?   // nil = 新增；非 nil = 编辑（左滑 Edit 进入，预填 + 走 update）

    private var pet: Pet? { store.pets.first { $0.id == petID } }

    private var saveTitle: LocalizedStringKey {
        if existing != nil { return "Update deworming" }
        if let pet { return "Save for \(pet.name)" }
        return "Save deworming"
    }

    @State private var kind: DewormingKind
    @State private var administeredDate: Date
    @State private var hasNextDue: Bool
    @State private var nextDueDate: Date
    @State private var productName: String
    @State private var notes: String

    init(petID: UUID, existing: DewormingRecord? = nil) {
        self.petID = petID
        self.existing = existing
        _kind = State(initialValue: existing?.kind ?? .internalParasite)
        _administeredDate = State(initialValue: existing?.administeredDate ?? Date())
        _hasNextDue = State(initialValue: existing.map { $0.nextDueDate != nil } ?? true)
        // 驱虫复诊周期通常比疫苗短，默认下次到期给 3 个月（用户可改）
        _nextDueDate = State(initialValue: existing?.nextDueDate
            ?? Calendar.current.date(byAdding: .month, value: 3, to: Date()) ?? Date())
        _productName = State(initialValue: existing?.productName ?? "")
        _notes = State(initialValue: existing?.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Type", selection: $kind) {
                        ForEach(DewormingKind.allCases) { k in
                            Text(k.displayName).tag(k)
                        }
                    }
                    DatePicker("Date given", selection: $administeredDate, displayedComponents: .date)
                } header: {
                    PetContextHeader(pet: pet)
                }
                .listRowBackground(Color.ppSurface)

                Section {
                    Toggle("Set next due date", isOn: $hasNextDue)
                        .tint(Color.ppPrimary)
                    if hasNextDue {
                        DatePicker("Next due date", selection: $nextDueDate, displayedComponents: .date)
                    }
                } header: {
                    Text("When the next dose is recommended")
                }
                .listRowBackground(Color.ppSurface)

                Section {
                    LabeledContent("Product") {
                        TextField("E.g. Drontal", text: $productName)
                            .multilineTextAlignment(.trailing)
                    }
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...4)
                } header: {
                    Text("Optional")
                }
                .listRowBackground(Color.ppSurface)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollContentBackground(.hidden)
            .background(Color.ppBackground)
            .navigationTitle(existing == nil ? "Add deworming" : "Edit deworming")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                    }
                    .tint(Color.ppTextSecondary)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: PPSpacing.lg) {
                    PPPrimaryButton(title: saveTitle) {
                        save()
                    }
                    .shadow(radius: 10)
                    // 编辑模式才有删除入口
                    if let r = existing {
                        Button(role: .destructive) {
                            store.deleteDeworming(r)
                            dismiss()
                            SWAlertManager.shared.show(.success, message: "Deworming deleted")
                        } label: {
                            Text("Delete record")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .foregroundStyle(Color.ppDanger)
                        }
                    }
                }
                .padding(.horizontal, PPSpacing.xxxl)
            }
        }
    }

    private func save() {
        let trimmedProduct = productName.trimmingCharacters(in: .whitespaces)
        let trimmedNotes = notes.trimmingCharacters(in: .whitespaces)
        let record = DewormingRecord(
            petID: petID,
            kind: kind,
            administeredDate: administeredDate,
            nextDueDate: hasNextDue ? nextDueDate : nil,
            productName: trimmedProduct.isEmpty ? nil : trimmedProduct,
            notes: trimmedNotes.isEmpty ? nil : trimmedNotes
        )
        if var r = existing {
            r.kind = kind
            r.administeredDate = administeredDate
            r.nextDueDate = hasNextDue ? nextDueDate : nil
            r.productName = trimmedProduct.isEmpty ? nil : trimmedProduct
            r.notes = trimmedNotes.isEmpty ? nil : trimmedNotes
            store.updateDeworming(r)
            SWAlertManager.shared.show(.success, message: "Deworming updated")
        } else {
            store.addDeworming(record)
            SWAlertManager.shared.show(.success, message: "Deworming added")
        }
        dismiss()
    }
}

#Preview("Vaccine") {
    AddVaccinationSheet(petID: Pet.mocks[1].id)
        .environment(PetBookStore())
}

#Preview("Weight") {
    AddWeightSheet(petID: Pet.mocks[1].id)
        .environment(PetBookStore())
}

#Preview("Deworming") {
    AddDewormingSheet(petID: Pet.mocks[1].id)
        .environment(PetBookStore())
}
