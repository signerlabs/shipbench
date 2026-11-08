//
//  MockData.swift
//  PetBook
//
//  前端 UI 调试用 mock seed。
//  种子 ID 在文件顶部一次性生成，跨集合用 ID 字符串关联（参考另一个项目的 MockData 模式）。
//

import Foundation

// MARK: - Stable seed IDs（跨集合关联用）

enum MockIDs {
    static let owner = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!

    // Pets
    static let petMochi = UUID(uuidString: "11111111-1111-1111-1111-000000000001")!  // 猫
    static let petBuddy = UUID(uuidString: "11111111-1111-1111-1111-000000000002")!  // 狗
    static let petLuna = UUID(uuidString: "11111111-1111-1111-1111-000000000003")!   // 猫（测 completePOC 回填）
    static let petMax = UUID(uuidString: "11111111-1111-1111-1111-000000000004")!    // 狗（测 registerDogLicence 回填）
    static let petCoco = UUID(uuidString: "11111111-1111-1111-1111-000000000005")!   // 狗（最小档案：只填名字，芯片等可选全空）

    // Vet clinics
    static let vetMtPleasant = UUID(uuidString: "22222222-2222-2222-2222-000000000001")!
    static let vetBeechave = UUID(uuidString: "22222222-2222-2222-2222-000000000002")!
    static let vetAnimalRecoveryCentre = UUID(uuidString: "22222222-2222-2222-2222-000000000003")!
    static let vetCompanionAnimalSurgery = UUID(uuidString: "22222222-2222-2222-2222-000000000004")!

    // Vets（医生）
    static let docLim = UUID(uuidString: "33333333-3333-3333-3333-000000000001")!
    static let docTan = UUID(uuidString: "33333333-3333-3333-3333-000000000002")!
    static let docWong = UUID(uuidString: "33333333-3333-3333-3333-000000000003")!
    static let docRahman = UUID(uuidString: "33333333-3333-3333-3333-000000000004")!
    static let docChen = UUID(uuidString: "33333333-3333-3333-3333-000000000005")!
    static let docKumar = UUID(uuidString: "33333333-3333-3333-3333-000000000006")!
}

// 相对今天的日期偏移辅助函数
private func daysAgo(_ n: Int) -> Date {
    Calendar.current.date(byAdding: .day, value: -n, to: Date()) ?? Date()
}

private func daysFromNow(_ n: Int) -> Date {
    Calendar.current.date(byAdding: .day, value: n, to: Date()) ?? Date()
}

/// N 天后的 H:00（整点，用于医生排班占用 slot）
private func dayAtHour(_ daysAhead: Int, _ hour: Int) -> Date {
    let cal = Calendar.current
    let day = cal.date(byAdding: .day, value: daysAhead, to: Date()) ?? Date()
    return cal.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
}

// MARK: - Owner

extension Owner {
    static let mock = Owner(
        id: MockIDs.owner,
        displayName: "Guest",
        email: nil,
        postalCode: nil,
        residenceType: nil,
        primaryPhone: nil,
        emergencyContact: nil,
        language: .en,
        hasLinkedAppleID: false,
        pocCompleted: false   // owner 未完成 POC → 可演示「首页出 POC 待办 → 标记完成 → 待办消失」全链路
    )
}

// MARK: - Pets

extension Pet {
    static let mocks: [Pet] = [
        Pet(
            id: MockIDs.petMochi,
            ownerID: MockIDs.owner,
            species: .cat,
            name: "Mochi",
            breed: "Domestic Shorthair",
            sex: .female,
            dob: daysAgo(365 * 3),
            microchipID: "900164001234567",
            sterilized: true,
            pocCompleted: true,
            avsLicenseID: nil,
            avsLicenseExpiry: nil,
            photoAssetName: nil,
            backgroundAssetName: nil,   // Home 沉浸页背景 demo（复用同款照片 asset）
            adoptionDate: daysAgo(540),
            createdAt: daysAgo(7)
        ),
        Pet(
            id: MockIDs.petBuddy,
            ownerID: MockIDs.owner,
            species: .dog,
            name: "Buddy",
            breed: "Golden Retriever",
            sex: .male,
            dob: daysAgo(365 * 5),
            microchipID: "900164009876543",
            sterilized: true,
            pocCompleted: nil,  // 狗主无 POC 概念
            avsLicenseID: "SG-DOG-2025-00892",
            avsLicenseExpiry: daysFromNow(20),   // ≤30 天 → renewLicence 待办（测「改到期日」回填）
            photoAssetName: nil,
            backgroundAssetName: nil,   // Home 沉浸页背景 demo（复用同款照片 asset）
            adoptionDate: daysAgo(365 * 4),
            createdAt: daysAgo(30)
        ),
        // Luna（猫）— POC 未完成 → completePOC 待办（测「标记 POC 完成」回填；完成后转 applyCatLicence 可续测）
        Pet(
            id: MockIDs.petLuna,
            ownerID: MockIDs.owner,
            species: .cat,
            name: "Luna",
            breed: "Ragdoll",
            sex: .female,
            dob: daysAgo(365 * 1),
            microchipID: "900164005551234",
            sterilized: false,
            pocCompleted: nil,        // 未完成 POC
            avsLicenseID: nil,
            avsLicenseExpiry: nil,
            photoAssetName: nil,      // 无照片 → emoji 兜底
            adoptionDate: daysAgo(200),
            createdAt: daysAgo(5)
        ),
        // Max（狗）— 未登记牌照 → registerDogLicence 待办（测「填执照号」回填）
        Pet(
            id: MockIDs.petMax,
            ownerID: MockIDs.owner,
            species: .dog,
            name: "Max",
            breed: "Beagle",
            sex: .male,
            dob: daysAgo(365 * 2),
            microchipID: "900164006667890",
            sterilized: true,
            pocCompleted: nil,
            avsLicenseID: nil,        // 未登记牌照
            avsLicenseExpiry: nil,
            photoAssetName: nil,      // 无照片 → emoji 兜底
            adoptionDate: daysAgo(300),
            createdAt: daysAgo(10)
        ),
        // Coco（狗）— 只填名字等必选项；microchip / 品种 / 牌照 / 体重等可选全空。
        // 用途：测 PALS「Microchipped」未满足态 + 宠物详情字段缺失的优雅降级。
        Pet(
            id: MockIDs.petCoco,
            ownerID: MockIDs.owner,
            species: .dog,
            name: "Coco",
            breed: nil,
            sex: .unknown,
            dob: nil,
            microchipID: nil,        // 芯片未填 → PALS「Microchipped」显示未满足
            sterilized: nil,
            pocCompleted: nil,
            avsLicenseID: nil,
            avsLicenseExpiry: nil,
            photoAssetName: nil,
            adoptionDate: nil,
            createdAt: daysAgo(0)
        )
    ]
}

// MARK: - Vaccinations

extension VaccinationRecord {
    static let mocks: [VaccinationRecord] = [
        // Mochi - 猫
        VaccinationRecord(
            petID: MockIDs.petMochi,
            vaccineType: .fvrcp,
            administeredDate: daysAgo(300),
            nextDueDate: daysFromNow(60),
            brand: "Nobivac",
            vetClinicID: MockIDs.vetMtPleasant
        ),
        // Buddy - 狗
        VaccinationRecord(
            petID: MockIDs.petBuddy,
            vaccineType: .dhppl,
            administeredDate: daysAgo(200),
            nextDueDate: daysFromNow(160),
            brand: "Nobivac DHPPi",
            vetClinicID: MockIDs.vetBeechave
        ),
        VaccinationRecord(
            petID: MockIDs.petBuddy,
            vaccineType: .lepto,
            administeredDate: daysAgo(200),
            nextDueDate: daysFromNow(160),
            vetClinicID: MockIDs.vetBeechave
        ),
        VaccinationRecord(
            petID: MockIDs.petBuddy,
            vaccineType: .rabies,
            administeredDate: daysAgo(200),
            nextDueDate: daysFromNow(530),
            vetClinicID: MockIDs.vetBeechave
        )
    ]
}

// MARK: - Deworming

extension DewormingRecord {
    static let mocks: [DewormingRecord] = [
        DewormingRecord(
            petID: MockIDs.petMochi,
            kind: .internalParasite,
            administeredDate: daysAgo(40),
            nextDueDate: daysFromNow(50),
            productName: "Drontal Cat"
        ),
        DewormingRecord(
            petID: MockIDs.petBuddy,
            kind: .heartworm,
            administeredDate: daysAgo(20),
            nextDueDate: daysFromNow(10),
            productName: "Heartgard Plus"
        ),
        DewormingRecord(
            petID: MockIDs.petBuddy,
            kind: .external,
            administeredDate: daysAgo(20),
            nextDueDate: daysFromNow(40),
            productName: "NexGard"
        )
    ]
}

// MARK: - Vet visits

extension VetVisitRecord {
    static let mocks: [VetVisitRecord] = [
        VetVisitRecord(
            petID: MockIDs.petMochi,
            visitDate: daysAgo(45),
            vetClinicID: MockIDs.vetMtPleasant,
            vetName: "Dr. Lim",
            diagnosis: "Annual checkup",
            notes: "Healthy weight, teeth cleaning recommended next visit",
            followUpNeeded: false
        ),
        VetVisitRecord(
            petID: MockIDs.petBuddy,
            visitDate: daysAgo(15),
            vetClinicID: MockIDs.vetBeechave,
            vetName: "Dr. Tan",
            diagnosis: "Mild ear infection",
            notes: "10-day course of ear drops, recheck in 2 weeks",
            followUpNeeded: true,
            followUpDate: daysFromNow(5)
        )
    ]
}

// MARK: - Weight

extension WeightRecord {
    static let mocks: [WeightRecord] = [
        // Mochi（猫）— 过去一年月度体重，4kg 级缓升、带自然小波动
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(365), weightKg: 3.6),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(330), weightKg: 3.7),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(300), weightKg: 3.8),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(270), weightKg: 3.9),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(240), weightKg: 3.85),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(210), weightKg: 3.95),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(180), weightKg: 4.0),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(150), weightKg: 4.05),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(120), weightKg: 4.15),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(90),  weightKg: 4.1),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(60),  weightKg: 4.25),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(30),  weightKg: 4.2),
        WeightRecord(petID: MockIDs.petMochi, recordedDate: daysAgo(7),   weightKg: 4.3),
        // Buddy（狗）— 过去一年月度体重，28kg 级，带自然小波动
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(365), weightKg: 26.5),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(330), weightKg: 26.9),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(300), weightKg: 27.2),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(270), weightKg: 27.0),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(240), weightKg: 27.5),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(210), weightKg: 27.9),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(180), weightKg: 27.8),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(150), weightKg: 28.3),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(120), weightKg: 28.6),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(90),  weightKg: 28.2),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(60),  weightKg: 28.7),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(30),  weightKg: 28.5),
        WeightRecord(petID: MockIDs.petBuddy, recordedDate: daysAgo(7),   weightKg: 29.0)
    ]
}

// MARK: - Vet clinics（SG real-ish 数据，4 家样本，含 1 家 24h）

extension VetClinic {
    static let mocks: [VetClinic] = [
        VetClinic(
            id: MockIDs.vetMtPleasant,
            name: "Mount Pleasant Veterinary Centre",
            address: "232 Whitley Road, Singapore",
            postalCode: "297824",
            latitude: 1.3303,
            longitude: 103.8345,
            phone: "+6562501234",
            whatsapp: nil,
            services: [.vet, .grooming],
            is24h: false,
            imageName: "clinic-1"
        ),
        VetClinic(
            id: MockIDs.vetBeechave,
            name: "Beecroft Animal Specialist & Emergency Hospital",
            address: "5 Burn Road #01-01, Singapore",
            postalCode: "369972",
            latitude: 1.3296,
            longitude: 103.8854,
            phone: "+6568842420",
            whatsapp: nil,
            services: [.vet, .emergency24h],
            is24h: true,
            imageName: "clinic-2"
        ),
        VetClinic(
            id: MockIDs.vetAnimalRecoveryCentre,
            name: "Animal Recovery Veterinary Referral Centre",
            address: "207 Bukit Timah Road, Singapore",
            postalCode: "229823",
            latitude: 1.3247,
            longitude: 103.8345,
            phone: "+6562323070",
            whatsapp: nil,
            services: [.vet, .emergency24h],
            is24h: true,
            imageName: "clinic-3"
        ),
        VetClinic(
            id: MockIDs.vetCompanionAnimalSurgery,
            name: "Companion Animal Surgery",
            address: "Block 41 Bayshore Road #01-742",
            postalCode: "469983",
            latitude: 1.3115,
            longitude: 103.9462,
            phone: "+6562443866",
            whatsapp: "+6591234567",
            services: [.vet, .boarding],
            is24h: false,
            imageName: "clinic-4"
        )
    ]
}

// MARK: - Breed rules（小样本，骨架阶段够用）

extension BreedRule {
    static let mocks: [BreedRule] = [
        BreedRule(breedName: "Golden Retriever", species: .dog, hdbApproved: false, specifiedDog: false, projectAdoreEligible: true, notes: "Too large for HDB; consider Project ADORE"),
        BreedRule(breedName: "Singapore Special", species: .dog, hdbApproved: true, projectAdoreEligible: true),
        BreedRule(breedName: "German Shepherd", species: .dog, hdbApproved: false, specifiedDog: true, notes: "Specified Dog — additional licensing required"),
        BreedRule(breedName: "Poodle (Miniature)", species: .dog, hdbApproved: true),
        BreedRule(breedName: "Shih Tzu", species: .dog, hdbApproved: true),
        BreedRule(breedName: "Domestic Shorthair", species: .cat, hdbApproved: true),
        BreedRule(breedName: "Persian", species: .cat, hdbApproved: true),
        BreedRule(breedName: "Maine Coon", species: .cat, hdbApproved: true),
        BreedRule(breedName: "Ragdoll", species: .cat, hdbApproved: true)
    ]
}

// MARK: - Clinic services（诊所可预约服务目录，全局共用）

extension ClinicService {
    static let catalog: [ClinicService] = [
        .init(id: "consult",  name: "General Consultation", priceSGD: 45,  durationMinutes: 30, blurb: "Health check & professional advice", icon: "stethoscope"),
        .init(id: "vaccine",  name: "Vaccination",          priceSGD: 35,  durationMinutes: 20, blurb: "Core vaccines & boosters",          icon: "syringe"),
        .init(id: "grooming", name: "Grooming",             priceSGD: 60,  durationMinutes: 60, blurb: "Bath, trim & nail clipping",       icon: "scissors"),
        .init(id: "dental",   name: "Dental Scaling",       priceSGD: 120, durationMinutes: 45, blurb: "Plaque & tartar removal",          icon: "mouth"),
        .init(id: "boarding", name: "Boarding (per night)", priceSGD: 50,  durationMinutes: 0,  blurb: "Overnight stay & care",            icon: "house.fill"),
    ]
}

// MARK: - Appointments（示例预约，展示 Orders tab 的 Upcoming / Past 分组）

extension Appointment {
    static let mocks: [Appointment] = [
        // Upcoming · Confirmed — Mochi 疫苗（Dr. Lim）
        Appointment(
            reference: "PP-4K2M",
            clinicID: MockIDs.vetMtPleasant,
            serviceID: "vaccine",
            vetID: MockIDs.docLim,
            petID: MockIDs.petMochi,
            scheduledDate: dayAtHour(3, 11),
            reason: "Annual FVRCP booster",
            isNewPatient: false,
            status: .confirmed,
            createdAt: daysAgo(2)
        ),
        // Upcoming · Requested — Buddy 复诊（Dr. Wong）
        Appointment(
            reference: "PP-9XQ7",
            clinicID: MockIDs.vetBeechave,
            serviceID: "consult",
            vetID: MockIDs.docWong,
            petID: MockIDs.petBuddy,
            scheduledDate: dayAtHour(6, 14),
            reason: "Ear infection recheck",
            isNewPatient: false,
            status: .requested,
            createdAt: daysAgo(0)
        ),
        // Upcoming · Confirmed — Buddy 洗牙（Dr. Kumar）
        Appointment(
            reference: "PP-7H5N",
            clinicID: MockIDs.vetCompanionAnimalSurgery,
            serviceID: "dental",
            vetID: MockIDs.docKumar,
            petID: MockIDs.petBuddy,
            scheduledDate: dayAtHour(9, 10),
            reason: "Dental scaling",
            isNewPatient: false,
            status: .confirmed,
            createdAt: daysAgo(3)
        ),
        // Upcoming · Requested — Mochi 看诊（Dr. Tan）
        Appointment(
            reference: "PP-2L8K",
            clinicID: MockIDs.vetMtPleasant,
            serviceID: "consult",
            vetID: MockIDs.docTan,
            petID: MockIDs.petMochi,
            scheduledDate: dayAtHour(14, 15),
            reason: "Loss of appetite",
            isNewPatient: false,
            status: .requested,
            createdAt: daysAgo(1)
        ),
        // Upcoming · Confirmed — Buddy 美容（Dr. Wong）
        Appointment(
            reference: "PP-6PW3",
            clinicID: MockIDs.vetBeechave,
            serviceID: "grooming",
            vetID: MockIDs.docWong,
            petID: MockIDs.petBuddy,
            scheduledDate: dayAtHour(21, 11),
            reason: nil,
            isNewPatient: false,
            status: .confirmed,
            createdAt: daysAgo(2)
        ),
        // Upcoming · Requested — Mochi 疫苗（Dr. Lim）
        Appointment(
            reference: "PP-1J9D",
            clinicID: MockIDs.vetMtPleasant,
            serviceID: "vaccine",
            vetID: MockIDs.docLim,
            petID: MockIDs.petMochi,
            scheduledDate: dayAtHour(33, 13),
            reason: "FVRCP booster",
            isNewPatient: true,
            status: .requested,
            createdAt: daysAgo(0)
        ),
        // Past · Completed — Buddy 美容（Dr. Kumar）
        Appointment(
            reference: "PP-3RT8",
            clinicID: MockIDs.vetCompanionAnimalSurgery,
            serviceID: "grooming",
            vetID: MockIDs.docKumar,
            petID: MockIDs.petBuddy,
            scheduledDate: daysAgo(20),
            reason: nil,
            isNewPatient: false,
            status: .completed,
            createdAt: daysAgo(25)
        )
    ]
}

// MARK: - Vets（医生排班；bookedSlots 模拟"其他患者已约"，下单时置灰）

extension Vet {
    static let mocks: [Vet] = [
        // Mount Pleasant
        Vet(id: MockIDs.docLim, clinicID: MockIDs.vetMtPleasant,
            name: "Dr. Sarah Lim", title: "Senior Veterinarian",
            workingWeekdays: [2, 3, 4, 5, 6], startHour: 9, endHour: 18,
            bookedSlots: [dayAtHour(1, 10), dayAtHour(1, 15), dayAtHour(2, 11),
                          dayAtHour(3, 14), dayAtHour(4, 9)],
            photoAssetName: nil),
        Vet(id: MockIDs.docTan, clinicID: MockIDs.vetMtPleasant,
            name: "Dr. Wei Tan", title: "Veterinarian",
            workingWeekdays: [3, 5, 7], startHour: 10, endHour: 16,
            bookedSlots: [dayAtHour(1, 11), dayAtHour(2, 13), dayAtHour(3, 10)],
            photoAssetName: nil),

        // Beecroft（24h）
        Vet(id: MockIDs.docWong, clinicID: MockIDs.vetBeechave,
            name: "Dr. James Wong", title: "Emergency Veterinarian",
            workingWeekdays: [1, 2, 3, 4, 5, 6, 7], startHour: 8, endHour: 20,
            bookedSlots: [dayAtHour(1, 9), dayAtHour(1, 12), dayAtHour(1, 16),
                          dayAtHour(2, 10), dayAtHour(3, 15)],
            photoAssetName: nil),
        Vet(id: MockIDs.docRahman, clinicID: MockIDs.vetBeechave,
            name: "Dr. Aisha Rahman", title: "Veterinary Surgeon",
            workingWeekdays: [2, 4, 6], startHour: 9, endHour: 17,
            bookedSlots: [dayAtHour(2, 14), dayAtHour(3, 10), dayAtHour(4, 13)],
            photoAssetName: nil),

        // Animal Recovery
        Vet(id: MockIDs.docChen, clinicID: MockIDs.vetAnimalRecoveryCentre,
            name: "Dr. Mei Chen", title: "Referral Veterinarian",
            workingWeekdays: [2, 3, 4, 5, 6], startHour: 9, endHour: 18,
            bookedSlots: [dayAtHour(1, 13), dayAtHour(2, 9), dayAtHour(2, 15), dayAtHour(3, 11)],
            photoAssetName: nil),

        // Companion
        Vet(id: MockIDs.docKumar, clinicID: MockIDs.vetCompanionAnimalSurgery,
            name: "Dr. Raj Kumar", title: "Veterinarian",
            workingWeekdays: [2, 3, 4, 5, 6, 7], startHour: 9, endHour: 19,
            bookedSlots: [dayAtHour(1, 10), dayAtHour(1, 17), dayAtHour(3, 11), dayAtHour(4, 14)],
            photoAssetName: nil),
    ]
}
