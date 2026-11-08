//
//  AppointmentsView.swift
//  PetBook
//
//  Orders 一级 tab —— 到店预约的状态追踪中心（请求制，无二维码、无付费、无排队）。
//  顶部 Upcoming / Past 分段：
//    Upcoming = Requested + Confirmed，按期望时间升序（最近的在前）
//    Past     = Completed + Cancelled，按期望时间降序（最近的在前）
//  Upcoming 为信息密度较高的状态卡（状态徽章 + 宠物 + 服务 + 诊所 + 时间 + 预约号，
//  Requested 卡可取消）；Past 为紧凑行。
//  叙事重心是"诊所高效收预约请求"——凭证作用是状态追踪 + 提醒，故全程无核销二维码。
//

import SwiftUI

// MARK: - 分段

private enum AppointmentSegment: String, CaseIterable, Identifiable {
    case upcoming = "Upcoming"
    case past = "Past"
    var id: String { rawValue }
}

struct AppointmentsView: View {
    @Environment(PetBookStore.self) private var store

    @State private var segment: AppointmentSegment = .upcoming

    /// Upcoming：Requested + Confirmed，期望时间升序（最近的在最前）
    private var upcoming: [Appointment] {
        store.appointments
            .filter { $0.status == .requested || $0.status == .confirmed }
            .sorted { $0.scheduledDate < $1.scheduledDate }
    }

    /// Past：Completed + Cancelled，期望时间降序（最近的在最前）
    private var past: [Appointment] {
        store.appointments
            .filter { $0.status == .completed || $0.status == .cancelled }
            .sorted { $0.scheduledDate > $1.scheduledDate }
    }

    var body: some View {
        VStack(spacing: 0) {
            if segment == .upcoming {
                if upcoming.isEmpty {
                    UpcomingEmptyState()
                } else {
                    upcomingList
                }
            } else {
                if past.isEmpty {
                    PastEmptyState()
                } else {
                    pastList
                }
            }
        }
        .background(Color.ppBackground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                // 原生 Button 分段（与项目其他页一致；选中态 semibold + ppPrimary）
                HStack(spacing: PPSpacing.lg) {
                    ForEach(AppointmentSegment.allCases) { seg in
                        let isSelected = segment == seg
                        Button(seg.rawValue) {
                            withAnimation(.easeInOut(duration: 0.2)) { segment = seg }
                        }
                        .font(.subheadline)
                        .fontWeight(isSelected ? .semibold : .regular)
                        .foregroundStyle(isSelected ? Color.ppPrimary : Color.ppTextSecondary)
                    }
                }
            }
        }
        .ppBellToolbar()
        .ppShowsRootTabBar()
    }

    // MARK: Upcoming 列表（状态卡）

    private var upcomingList: some View {
        ScrollView {
            LazyVStack(spacing: PPSpacing.md) {
                ForEach(upcoming) { appt in
                    UpcomingCard(
                        appt: appt,
                        pet: appt.petID.flatMap { store.pet(id: $0) },
                        service: store.clinicService(id: appt.serviceID),
                        clinic: store.clinic(id: appt.clinicID),
                        vet: store.vet(id: appt.vetID),
                        onCancel: { store.cancelAppointment(appt.id) }
                    )
                }
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.sm)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Past 列表（紧凑行）

    private var pastList: some View {
        ScrollView {
            LazyVStack(spacing: PPSpacing.sm) {
                ForEach(past) { appt in
                    PastRow(
                        appt: appt,
                        pet: appt.petID.flatMap { store.pet(id: $0) },
                        service: store.clinicService(id: appt.serviceID),
                        clinic: store.clinic(id: appt.clinicID)
                    )
                }
            }
            .padding(.horizontal, PPSpacing.xl)
            .padding(.top, PPSpacing.sm)
            .padding(.bottom, 120)
        }
        .scrollIndicators(.hidden)
    }
}

// MARK: - 状态徽章展示映射（仿 HDBComplianceStatus 做法）

private extension AppointmentStatus {
    var label: String {
        switch self {
        case .requested: "Requested"
        case .confirmed: "Confirmed"
        case .completed: "Completed"
        case .cancelled: "Cancelled"
        }
    }

    /// 徽章配色：requested→ppWarning、confirmed→ppSuccess、completed→次要灰、cancelled→危险红。
    var tint: Color {
        switch self {
        case .requested: Color.ppWarning
        case .confirmed: Color.ppSuccess
        case .completed: Color.ppTextSecondary
        case .cancelled: Color.ppDanger
        }
    }

    var icon: String {
        switch self {
        case .requested: "clock.fill"
        case .confirmed: "checkmark.seal.fill"
        case .completed: "checkmark.circle.fill"
        case .cancelled: "xmark.circle.fill"
        }
    }
}

// MARK: - 状态徽章小组件

private struct StatusBadge: View {
    let status: AppointmentStatus

    var body: some View {
        HStack(spacing: PPSpacing.xs) {
            Image(systemName: status.icon)
                .font(.caption2)
            Text(status.label)
                .font(.caption)
                .fontWeight(.bold)
        }
        .foregroundStyle(status.tint)
        .padding(.horizontal, PPSpacing.sm)
        .padding(.vertical, PPSpacing.xs)
        .background(Capsule().fill(status.tint.opacity(0.15)))
    }
}

// MARK: - 日期格式（Orders 内共用）

private enum ApptFormat {
    /// "May 30, 2026 · 2:30 PM"
    static func dateTime(_ date: Date) -> String {
        date.formatted(.dateTime.year().month(.abbreviated).day().hour().minute())
    }
}

// MARK: - Upcoming 状态卡

private struct UpcomingCard: View {
    let appt: Appointment
    let pet: Pet?
    let service: ClinicService?
    let clinic: VetClinic?
    let vet: Vet?
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.md) {
            // 顶部：状态徽章 + 预约号
            HStack {
                StatusBadge(status: appt.status)
                Spacer()
                Text("#\(appt.reference)")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .fontDesign(.monospaced)
                    .foregroundStyle(Color.ppTextSecondary)
            }

            // 宠物 + 服务
            HStack(spacing: PPSpacing.md) {
                if let pet {
                    PPPetAvatar(pet: pet)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(service?.name ?? "Appointment")
                        .font(.headline)
                        .foregroundStyle(Color.ppTextPrimary)
                    Text(pet?.name ?? "—")
                        .font(.subheadline)
                        .foregroundStyle(Color.ppTextSecondary)
                }
                Spacer(minLength: 0)
            }

            divider

            // 诊所 + 期望时间
            VStack(alignment: .leading, spacing: PPSpacing.sm) {
                metaRow(icon: "cross.case.fill", text: clinic?.name ?? "—")
                if let vet {
                    metaRow(icon: "stethoscope", text: vet.name)
                } else if appt.vetID == nil {
                    metaRow(icon: "stethoscope", text: "Any available vet")
                }
                metaRow(icon: "calendar", text: ApptFormat.dateTime(appt.scheduledDate))
            }

            // Requested 卡才提供取消（已确认的预约改约走线下，符合 demo 叙事）
            if appt.status == .requested {
                Button(action: cancel) {
                    Text("Cancel request")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.ppDanger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, PPSpacing.md)
                        .background(
                            Capsule()
                                .fill(Color.ppDanger.opacity(0.1))
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(PPSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                .fill(Color.ppSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                .strokeBorder(Color.ppBorder, lineWidth: 1)
        )
    }

    private func cancel() {
        onCancel()
        SWAlertManager.shared.show(.info, message: "Appointment cancelled")
    }

    private func metaRow(icon: String, text: String) -> some View {
        HStack(spacing: PPSpacing.sm) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.ppTextSecondary)
                .frame(width: 18)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Color.ppTextPrimary)
                .lineLimit(1)
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.ppBorder)
            .frame(height: 1)
    }
}

// MARK: - Past 紧凑行

private struct PastRow: View {
    let appt: Appointment
    let pet: Pet?
    let service: ClinicService?
    let clinic: VetClinic?

    var body: some View {
        HStack(spacing: PPSpacing.md) {
            if let pet {
                PPPetAvatar(pet: pet)
            } else {
                // 缺宠物兜底图标
                Image(systemName: "pawprint.fill")
                    .font(.subheadline)
                    .foregroundStyle(Color.ppTextSecondary)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color.ppBackground))
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(service?.name ?? "Appointment")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.ppTextPrimary)
                    .lineLimit(1)
                Text("\(pet?.name ?? "—") · \(clinic?.name ?? "—")")
                    .font(.caption)
                    .foregroundStyle(Color.ppTextSecondary)
                    .lineLimit(1)
                Text(ApptFormat.dateTime(appt.scheduledDate))
                    .font(.caption2)
                    .foregroundStyle(Color.ppTextSecondary)
            }

            Spacer(minLength: PPSpacing.sm)

            StatusBadge(status: appt.status)
        }
        .padding(PPSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                .fill(Color.ppSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                .strokeBorder(Color.ppBorder, lineWidth: 1)
        )
    }
}

// MARK: - 空状态

private struct UpcomingEmptyState: View {
    var body: some View {
        VStack(spacing: PPSpacing.lg) {
            Image(systemName: "calendar.badge.plus")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.ppPrimary.opacity(0.5))
                .padding(28)
                .background(Circle().fill(Color.ppSurface))

            VStack(spacing: PPSpacing.sm) {
                Text("No upcoming appointments")
                    .font(.title3)
                    .fontWeight(.semibold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                Text("Find a clinic on the Map to book a visit for your pet.")
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, PPSpacing.xl)
            }
        }
        .padding(.top, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private struct PastEmptyState: View {
    var body: some View {
        VStack(spacing: PPSpacing.md) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(Color.ppTextSecondary)
            Text("No past appointments yet")
                .font(.headline)
                .foregroundStyle(Color.ppTextPrimary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    NavigationStack {
        AppointmentsView()
    }
    .environment(PetBookStore())
    .environment(PetBookTabBarController())
}
