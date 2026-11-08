//
//  OnboardingState.swift
//  PetBook
//
//  Onboarding 2 屏的共享状态（物种选择 → 输入名字）。顶层 OnboardingFlow
//  通过 step: OnboardingStep enum + .transition() 切换两屏。
//  品种、绝育、DOB 等详细信息由 Home 的 Profile Completion 引导卡逐步收集。
//

import Foundation
import Observation
import SwiftUI

enum OnboardingStep: Hashable {
    case species
    case info
    case celebration   // 第 3 屏：宠物创建成功的庆祝 + 通知软引导（CelebrationSection）
}

@Observable
final class OnboardingState {
    var step: OnboardingStep = .species

    // 屏 1
    var species: Species?

    // 屏 2
    var petName: String = ""
    var petBreed: String = ""

    // MARK: - 派生校验

    var canProceedFromSpecies: Bool { species != nil }

    /// 屏 2 Basic tab 必填：名字。
    var basicTabValid: Bool {
        !petName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// 屏 2 只需名字即可继续。
    var canProceedFromInfo: Bool { basicTabValid }

    // MARK: - 流程切换（双向）

    func goToInfo() {
        withAnimation(.easeInOut(duration: 0.4)) {
            step = .info
        }
    }

    func goBackToSpecies() {
        withAnimation(.easeInOut(duration: 0.4)) {
            step = .species
        }
    }

    func goToCelebration() {
        withAnimation(.easeInOut(duration: 0.4)) {
            step = .celebration
        }
    }


    // MARK: - 构造 Pet

    func makePet(ownerID: UUID) -> Pet? {
        guard let species else { return nil }
        return Pet(
            ownerID: ownerID,
            species: species,
            name: petName.trimmingCharacters(in: .whitespaces),
            breed: petBreed.isEmpty ? nil : petBreed,
            sex: .unknown,
            dob: nil,
            microchipID: nil,
            sterilized: nil,
            pocCompleted: nil,
            avsLicenseID: nil,
            avsLicenseExpiry: nil,
            photoAssetName: nil,
            adoptionDate: nil,
            createdAt: Date()
        )
    }

    func reset() {
        step = .species
        species = nil
        petName = ""
        petBreed = ""
    }
}

