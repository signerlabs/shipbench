import Foundation
import UserNotifications

enum ProfileCompletionStep: Int, CaseIterable, Identifiable {
    case addPhoto = 0
    case selectBreed
    case setSterilized
    case setPOC
    case setDateOfBirth
    case addFirstVaccine
    case enableReminders

    var id: Int { rawValue }
}

enum ProfileCompletionFeed {

    static func pendingSteps(
        for pet: Pet,
        store: PetBookStore,
        notificationAuthorized: Bool
    ) -> [ProfileCompletionStep] {
        var steps: [ProfileCompletionStep] = []

        if pet.photoAssetName == nil {
            steps.append(.addPhoto)
        }
        if pet.breed == nil {
            steps.append(.selectBreed)
        }
        if pet.sterilized == nil {
            steps.append(.setSterilized)
        }
        // POC 是 owner 级一次性资质（不分猫狗、不 per-pet）：owner 未完成就提供入口，
        // 完成后所有宠物的这一步都消失。天然满足「首只打勾后后续不再重复」，
        // 又堵住「首只没打勾、建第二只时入口丢失」的漏洞。
        if !store.owner.pocCompleted {
            steps.append(.setPOC)
        }
        if pet.dob == nil {
            steps.append(.setDateOfBirth)
        }
        if store.vaccinations(of: pet.id).isEmpty {
            steps.append(.addFirstVaccine)
        }
        if !notificationAuthorized {
            steps.append(.enableReminders)
        }

        return steps
    }

    /// 分母：POC 步骤仅在 owner 未完成时计入（完成后该步骤全局消失，分母 -1）。
    /// 不再依赖物种——POC 是 owner 级一次性资质，猫狗通用。
    static func totalSteps(for pet: Pet, store: PetBookStore) -> Int {
        store.owner.pocCompleted ? ProfileCompletionStep.allCases.count - 1
                                 : ProfileCompletionStep.allCases.count
    }

    static func completionProgress(
        for pet: Pet,
        store: PetBookStore,
        notificationAuthorized: Bool
    ) -> Double {
        let total = totalSteps(for: pet, store: store)
        let pending = pendingSteps(for: pet, store: store, notificationAuthorized: notificationAuthorized).count
        guard total > 0 else { return 1.0 }
        return Double(total - pending) / Double(total)
    }

    // MARK: - Notification authorization

    @MainActor
    static func checkNotificationAuthorization() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized
    }
}
