import SwiftUI
import PhotosUI
import UserNotifications

struct ProfileCompletionFlow: View {
    let petID: UUID
    let onNotificationChanged: (Bool) -> Void

    @Environment(PetBookStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var pages: [ProfileCompletionStep] = []
    @State private var currentPage = 0
    @State private var notificationAuthorized = false
    /// 刚完成的步骤：600ms 内该步骤页图标位显示绿勾 flash（advance() 统一驱动）。
    @State private var completedFlash: ProfileCompletionStep?

    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var photoAdded = false
    @State private var selectedBreed = ""
    @State private var sterilizedChoice: Int? = nil
    @State private var pocChoice: Int? = nil
    @State private var selectedDOB: Date? = nil
    @State private var showDatePicker = false
    @State private var showVaccineSheet = false

    private var pet: Pet {
        store.pets.first { $0.id == petID } ?? Pet.mocks[0]
    }

    var body: some View {
        NavigationStack {
            content
                .background(Color.ppBackground)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: {
                            Image(systemName: "xmark")
                        }
                    }
                    ToolbarItem(placement: .principal) {
                        // 分段进度条：每段一个步骤，当前段拉长、已完成段填主色（替代 "Step x of y" 文字）
                        if !pages.isEmpty {
                            HStack(spacing: PPSpacing.xs) {
                                ForEach(0..<pages.count, id: \.self) { i in
                                    Capsule()
                                        .fill(i <= currentPage ? Color.ppPrimary : Color.ppBorder)
                                        .frame(width: i == currentPage ? 22 : 12, height: 4)
                                }
                            }
                            .animation(.spring(duration: 0.35), value: currentPage)
                        }
                    }
                }
        }
        .tint(Color.ppPrimary)
        .task {
            notificationAuthorized = await ProfileCompletionFeed.checkNotificationAuthorization()
            pages = ProfileCompletionFeed.pendingSteps(for: pet, store: store, notificationAuthorized: notificationAuthorized)
            if pages.isEmpty { dismiss() }
        }
        .sheet(isPresented: $showVaccineSheet) {
            AddVaccinationSheet(petID: petID)
        }
        .sheet(isPresented: $showDatePicker) {
            NavigationStack {
                DatePicker(
                    "Date of birth",
                    selection: Binding(
                        get: { selectedDOB ?? Date() },
                        set: { selectedDOB = $0 }
                    ),
                    in: ...Date(),
                    displayedComponents: .date
                )
                .datePickerStyle(.graphical)
                .tint(Color.ppPrimary)
                .padding()
                .navigationTitle("Date of birth")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            let dob = selectedDOB ?? Date()
                            selectedDOB = dob
                            var updated = pet
                            updated.dob = dob
                            store.updatePet(updated)
                            SWAlertManager.shared.show(.success, message: "Birthday saved")
                            showDatePicker = false
                            advance()
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            handlePhotoSelection(item)
        }
        .onChange(of: selectedBreed) { _, breed in
            guard !breed.isEmpty else { return }
            var updated = pet
            updated.breed = breed
            store.updatePet(updated)
            SWAlertManager.shared.show(.success, message: "Breed saved")
            advance()
        }
        .onChange(of: showVaccineSheet) { _, isPresented in
            if !isPresented, !store.vaccinations(of: petID).isEmpty {
                advance()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                let authorized = await ProfileCompletionFeed.checkNotificationAuthorization()
                guard authorized, !notificationAuthorized else { return }
                notificationAuthorized = authorized
                onNotificationChanged(true)
                SWAlertManager.shared.show(.success, message: "Reminders enabled")
                advance()
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if pages.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            TabView(selection: $currentPage) {
                ForEach(Array(pages.enumerated()), id: \.offset) { index, step in
                    stepPage(step).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // 底部 PPPageDots 已删：进度感知统一由顶部分段进度条承担，避免双指示器
        }
    }

    // MARK: - Step page

    @ViewBuilder
    private func stepPage(_ step: ProfileCompletionStep) -> some View {
            VStack(spacing: PPSpacing.xxl) {
                Spacer()

                // 完成瞬间：图标位 flash 绿勾（600ms，advance() 统一驱动），给「这步搞定了」的确认感
                if completedFlash == step {
                    Image(systemName: "checkmark")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(Color.ppSuccess))
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                } else if step == .addPhoto {
                    PPPetAvatar(pet: pet, size: 140)
                } else {
                    Image(systemName: stepIcon(step))
                        .font(.system(size: 32, weight: .medium))
                        .foregroundStyle(.ultraThickMaterial)
                        .frame(width: 72, height: 72)
                        .background(Circle().fill(Color.ppPrimary.opacity(0.8).gradient))
                }

                VStack(spacing: PPSpacing.sm) {
                    Text(stepTitle(step))
                        .font(.title2)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                        .foregroundStyle(Color.ppTextPrimary)
                        .multilineTextAlignment(.center)

                    Text(stepSubtitle(step))
                        .font(.body)
                        .foregroundStyle(Color.ppTextSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, PPSpacing.xxxl)

                stepContent(step)
                    .padding(.horizontal, PPSpacing.xxl)

                Spacer()
                Spacer()
            }
            .frame(maxWidth: .infinity)
    }

    // MARK: - Step content

    @ViewBuilder
    private func stepContent(_ step: ProfileCompletionStep) -> some View {
        switch step {
        case .addPhoto:
            if photoAdded {
                PPPrimaryButton(title: "Photo added", systemImage: "checkmark") {
                    showPhotoPicker = true
                }
            } else {
                PPPrimaryButton(title: "Choose photo", systemImage: "camera.fill") {
                    showPhotoPicker = true
                }
            }

        case .selectBreed:
            PPSearchablePicker(
                placeholder: "Select breed",
                sheetTitle: pet.species == .dog ? "Select Dog Breed" : "Select Cat Breed",
                searchPrompt: "Search breeds",
                selection: $selectedBreed,
                options: pet.species == .dog ? BreedCatalog.dogBreedNames : BreedCatalog.catBreeds
            ) { name in
                if pet.species == .dog, let status = BreedCatalog.dogStatus(for: name) {
                    HDBComplianceBadge(status: status)
                }
            } trigger: { open in
                if selectedBreed.isEmpty {
                    PPPrimaryButton(title: "Select breed", systemImage: "pawprint.fill") {
                        open()
                    }
                } else {
                    PPPrimaryButton(
                        title: LocalizedStringKey(selectedBreed),
                        systemImage: "checkmark"
                    ) {
                        open()
                    }
                }
            }

        case .setSterilized:
            VStack(spacing: PPSpacing.sm) {
                radioRow("Yes, sterilized", selected: sterilizedChoice == 0) {
                    sterilizedChoice = 0
                    var updated = pet
                    updated.sterilized = true
                    store.updatePet(updated)
                    SWAlertManager.shared.show(.success, message: "Sterilized — lifetime licence")
                    advance()
                }
                radioRow("No, not sterilized", selected: sterilizedChoice == 1) {
                    sterilizedChoice = 1
                    var updated = pet
                    updated.sterilized = false
                    store.updatePet(updated)
                    SWAlertManager.shared.show(.success, message: "Not sterilized — noted")
                    advance()
                }
                radioRow("I don't know", selected: sterilizedChoice == 2) {
                    sterilizedChoice = 2
                    var updated = pet
                    updated.sterilized = false
                    store.updatePet(updated)
                    SWAlertManager.shared.show(.info, message: "Assumed not sterilized — update anytime")
                    advance()
                }
            }

        case .setPOC:
            // POC 是 owner 级一次性资质：写回 owner.pocCompleted（走 updateOwner 通道，
            // mock 改本地 / network PATCH /v1/owner），完成后此人名下所有宠物的这一步都消失。
            VStack(spacing: PPSpacing.sm) {
                radioRow("I've completed it", selected: pocChoice == 0) {
                    pocChoice = 0
                    Task { await store.updateOwner { $0.pocCompleted = true } }
                    SWAlertManager.shared.show(.success, message: "Pet Ownership Course completed")
                    advance()
                }
                radioRow("Not yet", selected: pocChoice == 1) {
                    pocChoice = 1
                    Task { await store.updateOwner { $0.pocCompleted = false } }
                    SWAlertManager.shared.show(.info, message: "We'll remind you about the course")
                    advance()
                }
            }

        case .setDateOfBirth:
            VStack(spacing: PPSpacing.lg) {
                if selectedDOB != nil {
                    PPPrimaryButton(
                        title: "\(selectedDOB!.formatted(.dateTime.year().month(.wide).day()))",
                        systemImage: "checkmark"
                    ) {
                        showDatePicker = true
                    }
                } else {
                    PPPrimaryButton(title: "Select date", systemImage: "calendar") {
                        showDatePicker = true
                    }
                }
            }

        case .addFirstVaccine:
            if !store.vaccinations(of: petID).isEmpty {
                PPPrimaryButton(title: "Vaccine added", systemImage: "checkmark") {
                    showVaccineSheet = true
                }
            } else {
                PPPrimaryButton(title: "Add vaccine", systemImage: "syringe") {
                    showVaccineSheet = true
                }
            }

        case .enableReminders:
            // 通知价值前置：先让用户看见「将收到什么」（模拟系统通知横幅），再请求授权
            VStack(spacing: PPSpacing.xl) {
                PPNotificationPreviewCard(
                    message: "\(pet.name)'s rabies vaccine is due in 7 days"
                )

                if notificationAuthorized {
                    PPPrimaryButton(title: "Reminders enabled", systemImage: "checkmark") {
                        advance()
                    }
                } else {
                    PPPrimaryButton(title: "Enable", systemImage: "bell.fill") {
                        requestNotificationPermission()
                    }
                }
            }
        }
    }

    // MARK: - Shared UI

    private func radioRow(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: PPSpacing.md) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(selected ? Color.ppPrimary : Color.ppBorder)
                Text(title)
                    .font(.body)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.ppTextPrimary)
                Spacer()
            }
            .padding(PPSpacing.lg)
            .background(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .fill(selected ? Color.ppPrimary.opacity(0.08) : Color.ppSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: PPRadius.lg, style: .continuous)
                    .strokeBorder(selected ? Color.ppPrimary.opacity(0.3) : Color.ppBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.2), value: selected)
    }

    // MARK: - Actions

    private func advance() {
        // 600ms 等待期间当前步骤页图标位 flash 绿勾（完成确认），随后翻页 / 收尾
        if pages.indices.contains(currentPage) {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) {
                completedFlash = pages[currentPage]
            }
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            if currentPage < pages.count - 1 {
                withAnimation(.easeInOut(duration: 0.35)) {
                    currentPage += 1
                }
                completedFlash = nil
            } else {
                dismiss()
            }
        }
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let rawData = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: rawData),
                  let jpegData = image.jpegData(compressionQuality: 0.85) else {
                SWAlertManager.shared.show(.error, message: "Failed to load photo")
                return
            }
            do {
                try await store.replacePhoto(petID: petID, jpegData: jpegData)
                SWAlertManager.shared.show(.success, message: "Photo added")
            } catch {
                ImageCache.shared.store(image, forKey: "local/\(petID)/photo")
                var updated = pet
                updated.photoAssetName = "local/\(petID)/photo"
                store.updatePet(updated)
                SWAlertManager.shared.show(.success, message: "Photo added")
            }
            photoAdded = true
            advance()
        }
    }

    private func requestNotificationPermission() {
        Task {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()

            switch settings.authorizationStatus {
            case .notDetermined:
                let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
                notificationAuthorized = granted
                onNotificationChanged(granted)
                if granted {
                    SWAlertManager.shared.show(.success, message: "Reminders enabled")
                    advance()
                } else {
                    SWAlertManager.shared.show(.info, message: "You can enable reminders later in Settings")
                }
            case .denied:
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    await UIApplication.shared.open(url)
                }
            case .authorized, .provisional, .ephemeral:
                notificationAuthorized = true
                onNotificationChanged(true)
                advance()
            @unknown default:
                break
            }
        }
    }

    // MARK: - Display mapping

    private func stepIcon(_ step: ProfileCompletionStep) -> String {
        switch step {
        case .addPhoto:        "camera.fill"
        case .selectBreed:     "pawprint.fill"
        case .setSterilized:   "scissors"
        case .setPOC:          "graduationcap.fill"
        case .setDateOfBirth:  "birthday.cake.fill"
        case .addFirstVaccine: "syringe"
        case .enableReminders: "bell.fill"
        }
    }

    private func stepTitle(_ step: ProfileCompletionStep) -> String {
        switch step {
        case .addPhoto:        "Add a photo of \(pet.name)"
        case .selectBreed:     "What breed is \(pet.name)?"
        case .setSterilized:   "Is \(pet.name) sterilized?"
        case .setPOC:          "Complete the Pet Ownership Course"
        case .setDateOfBirth:  "When was \(pet.name) born?"
        case .addFirstVaccine: "Add \(pet.name)'s first vaccine"
        case .enableReminders: "Enable reminders"
        }
    }

    private func stepSubtitle(_ step: ProfileCompletionStep) -> String {
        switch step {
        case .addPhoto:
            "Give \(pet.name) a face — makes the app feel like yours"
        case .selectBreed:
            pet.species == .dog ? "Used for HDB compliance checks and breed-specific health advice"
            : "Helps with breed-specific health advice"
        case .setSterilized:
            "Determines your licence type — sterilized pets get a lifetime licence"
        case .setPOC:
            "AVS asks every first-time cat or dog owner to finish this free online course once. Have you done it?"
        case .setDateOfBirth:
            "For age-appropriate health reminders and birthday alerts"
        case .addFirstVaccine:
            "Start tracking vaccines to get timely reminders"
        case .enableReminders:
            "Get notified when vaccines, licences or check-ups are due"
        }
    }
}

#Preview("Cat") {
    ProfileCompletionFlow(petID: Pet.mocks[2].id, onNotificationChanged: { _ in })
        .environment(PetBookStore())
}

#Preview("Dog") {
    ProfileCompletionFlow(petID: Pet.mocks[4].id, onNotificationChanged: { _ in })
        .environment(PetBookStore())
}
