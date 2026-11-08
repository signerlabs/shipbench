//
//  ClinicDetailView.swift
//  PetBook
//
//  诊所详情 + 到店预约下单页（二级页面，从 MapView 的名片 push）。
//  单页 ScrollView：顶部 banner → 诊所 meta → 5 步预约表单
//  ①选服务（必选 radio）②选哪只宠物（必选 chips，PetBook 独门优势，视觉突出）
//  ③选期望时间（DatePicker）④就诊原因 + 新患者开关 ⑤sticky 底部 CTA。
//  叙事重心是"诊所高效收预约请求"——提交即 Requested（非付费、无二维码、无排队），
//  诊所确认后转 Confirmed（store 内 4 秒计时器模拟前台确认）。价格仅信息展示，不收钱。
//  二级页面不挂 .ppShowsRootTabBar()（tab bar 自动隐藏）。
//

import SwiftUI

struct ClinicDetailView: View {
    let clinic: VetClinic

    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // MARK: 选择态

    /// 必选 —— 未选服务时 sticky CTA 保持禁用
    @State private var selectedServiceID: String?
    /// 必选 —— 为哪只宠物预约（PetBook 的差异化卖点）
    @State private var selectedPetID: UUID?
    /// 必选 —— 预约哪位医生
    @State private var selectedVetID: UUID?
    /// 选中的日期（默认今天 0 点）
    @State private var selectedDay: Date = Calendar.current.startOfDay(for: Date())
    /// 必选 —— 选中的可用时段（精确到小时）
    @State private var selectedSlot: Date?
    /// 就诊原因（可空）
    @State private var reason: String = ""
    /// 是否首诊
    @State private var isNewPatient: Bool = false

    private var services: [ClinicService] { store.clinicServices }
    private var pets: [Pet] { store.pets }
    private var vets: [Vet] { store.vets(of: clinic.id) }

    private var selectedService: ClinicService? {
        services.first { $0.id == selectedServiceID }
    }

    /// 未来 14 天的可选日期（从今天起）
    private var dateRange: [Date] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        return (0..<14).compactMap { cal.date(byAdding: .day, value: $0, to: today) }
    }

    /// 选中日期的可约时段：指定医生 → 该医生时段；Any（nil）→ 诊所全部医生并集
    private var daySlots: [TimeSlot] {
        if let vetID = selectedVetID {
            return store.slots(forVet: vetID, on: selectedDay)
        }
        return store.slots(forClinic: clinic.id, on: selectedDay)
    }

    /// 选了服务 + 宠物 + 可用时段才允许提交（医生可保持 Any）
    private var canSubmit: Bool {
        selectedServiceID != nil && selectedPetID != nil && selectedSlot != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PPSpacing.xl) {
                banner
                metaSection
                petSection
                serviceSection
                vetSection
                scheduleSection
                reasonSection
                stickyCTA
            }
        }
        .scrollIndicators(.hidden)
        .background(Color.ppBackground.ignoresSafeArea())
        .ignoresSafeArea(edges: .top)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: selectedVetID) { selectedSlot = nil }
        .onChange(of: selectedDay) { selectedSlot = nil }
    }

    // MARK: - ① Banner（大图 + 暗色渐变 + 诊所名叠加，缺图时程序化兜底）

    private var banner: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let imageName = clinic.imageName {
                    Image(imageName)
                        .resizable()
                        .scaledToFill()
                } else {
                    // 缺图兜底：ppPrimary 渐变 + 医疗箱图标
                    LinearGradient(
                        colors: [Color.ppPrimary, Color.ppPrimary.opacity(0.65)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    .overlay(
                        Image(systemName: "cross.case")
                            .font(.system(size: 56, weight: .light))
                            .foregroundStyle(.white.opacity(0.55))
                    )
                }
            }
            .frame(maxWidth: .infinity)
            .frame(maxHeight: 360)
            .clipped()

            // 暗色渐变保证标题可读
            LinearGradient(
                colors: [.clear, .black.opacity(0.7)],
                startPoint: .center,
                endPoint: .bottom
            )
            .frame(height: 180)

            VStack(alignment: .leading, spacing: PPSpacing.xs) {
                if clinic.is24h {
                    HStack(spacing: PPSpacing.xs) {
                        Image(systemName: "cross.case.fill")
                            .font(.caption2)
                        Text("24h Emergency")
                            .font(.caption)
                            .fontWeight(.bold)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, PPSpacing.sm)
                    .padding(.vertical, PPSpacing.xs)
                    .background(Capsule().fill(Color.ppDanger))
                }

                Text(clinic.displayName)
                    .font(.title2)
                    .fontWeight(.bold)
                    .fontDesign(.rounded)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.leading)
            }
            .padding(PPSpacing.xl)
        }
    }

    // MARK: - ② 诊所 meta（地址 + 服务标签）

    private var metaSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            HStack(alignment: .top, spacing: PPSpacing.sm) {
                Image(systemName: "location.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.ppPrimary)
                    .frame(width: 18)
                Text("\(clinic.address) · \(clinic.postalCode)")
                    .font(.subheadline)
                    .foregroundStyle(Color.ppTextPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // 服务标签流（用 ServiceTag.displayName）
            HStack(spacing: PPSpacing.sm) {
                ForEach(clinic.services) { tag in
                    Text(tag.displayName)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.ppTextSecondary)
                        .padding(.horizontal, PPSpacing.md)
                        .padding(.vertical, PPSpacing.xs)
                        .background(
                            Capsule()
                                .fill(Color.ppSurface)
                                .overlay(Capsule().strokeBorder(Color.ppBorder, lineWidth: 1))
                        )
                }
            }
        }
        .padding(.horizontal, PPSpacing.xl)
    }

    // MARK: - ④ 选哪只宠物（必选 chips —— PetBook 独门优势，视觉突出）

    private var petSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            sectionHeader("Which pet?")

            if pets.isEmpty {
                Text("Add a pet first to book an appointment.")
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: PPSpacing.xl) {
                        ForEach(pets) { pet in
                            PetPickChip(
                                pet: pet,
                                isSelected: selectedPetID == pet.id,
                                onTap: { selectedPetID = pet.id }
                            )
                        }
                    }
                    .padding(.vertical, PPSpacing.xs)   // 留白避免 2pt 选中描边被裁
                }
            }
        }
        .safeAreaPadding(.horizontal, PPSpacing.xl)
    }

    // MARK: - ③ 选服务（必选 radio）

    private var serviceSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.sm) {
            sectionHeader("Choose a service")

            VStack(spacing: PPSpacing.sm) {
                ForEach(services) { service in
                    ServiceRow(
                        service: service,
                        isSelected: selectedServiceID == service.id,
                        onTap: { selectedServiceID = service.id }
                    )
                }
            }
        }
        .padding(.horizontal, PPSpacing.xl)
    }

    // MARK: - ⑤ 选医生（必选 chips，多医生排班）

    private var vetSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.lg) {
            sectionHeader("Vet preference")

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: PPSpacing.xl) {
                    // 默认 "Any vet"：用户无倾向时保持，提交后由诊所分配医生
                    AnyVetChip(
                        isSelected: selectedVetID == nil,
                        onTap: { selectedVetID = nil }
                    )
                    ForEach(vets) { vet in
                        VetPickChip(
                            vet: vet,
                            isSelected: selectedVetID == vet.id,
                            onTap: { selectedVetID = vet.id }
                        )
                    }
                }
                .padding(.vertical, PPSpacing.xs)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
        }
        .safeAreaPadding(.horizontal, PPSpacing.xl)
    }

    // MARK: - ⑥ 选日期 + 时段（该医生已占用的时段置灰禁用）

    private var scheduleSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            sectionHeader("Pick a time")

            // 日期横滑（未来 14 天）
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: PPSpacing.sm) {
                    ForEach(dateRange, id: \.self) { day in
                        DateChip(
                            day: day,
                            isSelected: Calendar.current.isDate(day, inSameDayAs: selectedDay),
                            onTap: { selectedDay = day }
                        )
                    }
                }
                .padding(.vertical, PPSpacing.xs)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)

            // 时段网格：占用的灰掉禁用
            if daySlots.isEmpty {
                Text("Not available on this day — try another date.")
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
                    .padding(.vertical, PPSpacing.sm)
            } else {
                LazyVGrid(columns: slotColumns, spacing: PPSpacing.sm) {
                    ForEach(daySlots) { slot in
                        SlotButton(
                            slot: slot,
                            isSelected: selectedSlot == slot.start,
                            onTap: { selectedSlot = slot.start }
                        )
                    }
                }
            }
        }
        .safeAreaPadding(.horizontal, PPSpacing.xl)
    }

    private var slotColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 88), spacing: PPSpacing.sm)]
    }

    // MARK: - ⑥ 就诊原因 + 新患者开关

    private var reasonSection: some View {
        VStack(alignment: .leading, spacing: PPSpacing.lg) {
            VStack(alignment: .leading, spacing: PPSpacing.sm) {
                sectionHeader("Reason for visit")

                TextField(
                    "e.g. Annual checkup, limping, vaccination…",
                    text: $reason,
                    axis: .vertical
                )
                .lineLimit(2...4)
                .font(.subheadline)
                .foregroundStyle(Color.ppTextPrimary)
                .padding(PPSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                        .fill(Color.ppSurface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                        .strokeBorder(Color.ppBorder, lineWidth: 1)
                )
            }

            Toggle(isOn: $isNewPatient) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("First visit to this clinic?")
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.ppTextPrimary)
                    Text("Helps the clinic prepare a new patient file")
                        .font(.caption)
                        .foregroundStyle(Color.ppTextSecondary)
                }
            }
            .tint(Color.ppPrimary)
            .padding(PPSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .fill(Color.ppSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .strokeBorder(Color.ppBorder, lineWidth: 1)
            )
        }
        .padding(.horizontal, PPSpacing.xl)
    }

    // MARK: - 提交 CTA（复用 PPPrimaryButton）

    private var stickyCTA: some View {
        PPPrimaryButton(
            title: canSubmit ? "Request appointment" : "Complete your selection",
            systemImage: "calendar.badge.plus",
            enabled: canSubmit
        ) {
            submit()
        }
        .padding(.horizontal, PPSpacing.xl)
        .padding(.vertical, PPSpacing.xl)
        .padding(.bottom, PPSpacing.xxxl)
    }

    // MARK: - 段头（caption uppercase tracking，与项目其他页一致）

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption)
            .fontWeight(.semibold)
            .tracking(0.8)
            .foregroundStyle(Color.ppTextSecondary)
    }

    // MARK: - 提交（创建 Requested 预约 → toast → 回 Map）

    private func submit() {
        guard let serviceID = selectedServiceID,
              let petID = selectedPetID,
              let slot = selectedSlot else { return }

        store.requestAppointment(
            clinicID: clinic.id,
            serviceID: serviceID,
            vetID: selectedVetID,   // nil = Any vet，交由诊所分配
            petID: petID,
            scheduledDate: slot,
            reason: reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : reason,
            isNewPatient: isNewPatient
        )

        SWAlertManager.shared.show(.success, message: "Appointment requested")
        dismiss()
    }
}

// MARK: - 服务行（radio 单选，整行可点）

private struct ServiceRow: View {
    let service: ClinicService
    let isSelected: Bool
    let onTap: () -> Void

    /// 时长 + 简介；durationMinutes == 0（如寄养）显 "per night"
    private var subtitle: String {
        if service.durationMinutes == 0 {
            return "per night · \(service.blurb)"
        }
        return "\(service.durationMinutes) min · \(service.blurb)"
    }

    /// 价格展示文案；寄养按晚计费
    private var priceText: String {
        service.durationMinutes == 0 ? "S$\(service.priceSGD)/night" : "S$\(service.priceSGD)"
    }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? Color.ppPrimary : Color.ppTextSecondary.opacity(0.5))

                Image(systemName: service.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.ppPrimary)
                    .frame(width: 36, height: 36)
                    .background(Circle().fill(Color.ppPrimary.opacity(0.1)))

                VStack(alignment: .leading, spacing: 2) {
                    Text(service.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.ppTextSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: PPSpacing.sm)

                Text(priceText)
                    .font(.subheadline)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.ppPrimary)
            }
            .padding(PPSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .fill(Color.ppSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .strokeBorder(isSelected ? Color.ppPrimary : Color.ppBorder,
                                  lineWidth: isSelected ? 2 : 1)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 宠物选择 chip（头像 + 名字，选中态 ppPrimary 描边）

private struct PetPickChip: View {
    let pet: Pet
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: PPSpacing.sm) {
                PPPetAvatar(pet: pet, size: 72)
                    .overlay {
                        Circle()
                            .strokeBorder(isSelected ? Color.ppPrimary : Color.ppBorder,
                                          lineWidth: isSelected ? 4 : 2)
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if isSelected {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.white, .ppPrimary)
                                .imageScale(.large)
                        }
                    }

                Text(pet.name)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextPrimary)
                    .lineLimit(1)
            }
            .frame(maxWidth: 124)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 医生选择 chip（monogram + 姓名 + 职称）

private struct VetPickChip: View {
    let vet: Vet
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: PPSpacing.sm) {
                Group {
                    if let asset = vet.photoAssetName {
                        Image(asset)
                            .resizable()
                            .scaledToFill()
                            .overlay {
                                Circle()
                                    .strokeBorder(isSelected ? Color.ppPrimary : Color.ppBorder,
                                                  lineWidth: isSelected ? 4 : 2)
                            }
                    } else {
                        ZStack {
                            Circle().fill(Color.ppPrimary.opacity(0.85))
                            Text(vet.initials)
                                .font(.headline)
                                .fontWeight(.bold)
                                .foregroundStyle(.white)
                        }
                    }
                }
                .frame(width: 72, height: 72)
                .clipShape(Circle())
                .overlay(alignment: .bottomTrailing) {
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white, .ppPrimary)
                            .imageScale(.large)
                    }
                }

                VStack(spacing: 1) {
                    Text(vet.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                        .lineLimit(1)
                    Text(vet.title)
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: 124)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 任意医生 chip（默认选项，无倾向时保持，提交后诊所分配）

private struct AnyVetChip: View {
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: PPSpacing.sm) {
                ZStack {
                    Circle().fill(isSelected ? Color.ppPrimary.opacity(0.15) : Color.ppSurface)
                    Image(systemName: "person.2.fill")
                        .font(.title3)
                        .foregroundStyle(isSelected ? Color.ppPrimary : Color.ppTextSecondary)
                }
                .frame(width: 72, height: 72)
                .overlay {
                    Circle()
                        .strokeBorder(isSelected ? Color.ppPrimary : Color.ppBorder,
                                      lineWidth: isSelected ? 4 : 2)
                }
                .overlay(alignment: .bottomTrailing) {
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.white, .ppPrimary)
                            .imageScale(.large)
                    }
                }

                VStack(spacing: 1) {
                    Text("Any vet")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppTextPrimary)
                        .lineLimit(1)
                    Text("No preference")
                        .font(.footnote)
                        .foregroundStyle(Color.ppTextSecondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: 124)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 日期 chip（星期 + 日）

private struct DateChip: View {
    let day: Date
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 2) {
                Text(day.formatted(.dateTime.weekday(.abbreviated)))
                    .font(.caption2)
                    .fontWeight(.medium)
                Text(day.formatted(.dateTime.day()))
                    .fontWeight(.bold)
                Text(day.formatted(.dateTime.month(.abbreviated)))
                    .font(.caption2)
                    .fontWeight(.medium)
            }
            .foregroundStyle(isSelected ? .white : Color.ppTextPrimary)
            .frame(width: 60, height: 76)
            .background(
                RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                    .fill(isSelected ? Color.ppPrimary : Color.ppSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                    .strokeBorder(isSelected ? Color.clear : Color.ppBorder, lineWidth: 1)
            )
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 时段按钮（占用置灰 + 删除线 + 禁用）

private struct SlotButton: View {
    let slot: TimeSlot
    let isSelected: Bool
    let onTap: () -> Void

    private var timeText: String {
        slot.start.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        Button(action: onTap) {
            Text(timeText)
                .font(.subheadline)
                .fontWeight(.semibold)
                .strikethrough(slot.isTaken)
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity)
                .padding(.vertical, PPSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                        .fill(background)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                        .strokeBorder(isSelected ? Color.ppPrimary : Color.ppBorder,
                                      lineWidth: isSelected ? 2 : 1)
                )
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(slot.isTaken)
    }

    private var foreground: Color {
        if slot.isTaken { return Color.ppTextSecondary.opacity(0.4) }
        return isSelected ? Color.ppPrimary : Color.ppTextPrimary
    }

    private var background: Color {
        if slot.isTaken { return Color.ppBorder.opacity(0.25) }
        return isSelected ? Color.ppPrimary.opacity(0.12) : Color.ppSurface
    }
}

#Preview {
    NavigationStack {
        ClinicDetailView(clinic: VetClinic.mocks[0])
    }
    .environment(PetBookStore())
}
