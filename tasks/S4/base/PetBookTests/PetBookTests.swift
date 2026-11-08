//
//  PetBookTests.swift
//  PetBookTests
//
//  提醒规划（ReminderPlanner）与请求体（PetPayload）的基本行为。不连网。
//

import Foundation
import Testing
@testable import PetBook

struct ReminderPlannerTests {
    @Test func offsetsFollowTheKind() {
        #expect(ReminderPlanner.offsets(for: .licenseExpiry) == [30, 7, 1, 0])
        #expect(ReminderPlanner.offsets(for: .vaccine) == [7, 1])
        #expect(ReminderPlanner.offsets(for: .deworming) == [7, 1])
        #expect(ReminderPlanner.offsets(for: .vetFollowUp) == [3, 1])
        #expect(ReminderPlanner.offsets(for: .birthday) == [0])
        #expect(ReminderPlanner.offsets(for: .vetAppointment).isEmpty)
    }

    @Test func bodyTextNamesThePetAndTheWhen() {
        #expect(ReminderPlanner.bodyText(name: "Mochi", kind: .vaccine, offset: 1) == "Mochi is due tomorrow. Book a vet visit.")
        #expect(ReminderPlanner.bodyText(name: "Mochi", kind: .deworming, offset: 7) == "Mochi is due in 7 days. Time for the next dose.")
        #expect(ReminderPlanner.bodyText(name: "Mochi", kind: .birthday, offset: 0) == "Happy birthday to Mochi! 🎂")
    }

    @Test func oneVaccinePlansOneReminderPerOffsetAtNineAM() {
        let store = PetBookStore(useMocks: false)
        let pet = Pet(ownerID: UUID(), species: .cat, name: "Mochi")
        let due = Calendar.current.date(byAdding: .day, value: 30, to: Calendar.current.startOfDay(for: Date()))!
        store.pets = [pet]
        store.vaccinations = [VaccinationRecord(petID: pet.id, vaccineType: .fvrcp, administeredDate: Date(), nextDueDate: due)]
        let plan = ReminderPlanner.plan(reminders: HomeFeed.upcomingReminders(store: store))
        #expect(plan.count == 2)
        #expect(Set(plan.map(\.offsetDays)) == [7, 1])
        #expect(plan.allSatisfy { Calendar.current.component(.hour, from: $0.fireDate) == ReminderPlanner.fireHour })
    }

    @Test func pastDueDatesAreNotPlanned() {
        let store = PetBookStore(useMocks: false)
        let pet = Pet(ownerID: UUID(), species: .dog, name: "Buddy")
        let due = Calendar.current.date(byAdding: .day, value: -10, to: Date())!
        store.pets = [pet]
        store.dewormings = [DewormingRecord(petID: pet.id, kind: .heartworm, administeredDate: due, nextDueDate: due)]
        #expect(ReminderPlanner.plan(reminders: HomeFeed.upcomingReminders(store: store)).isEmpty)
    }
}

struct PetPayloadTests {
    @Test func createCarriesTheFilledFields() throws {
        let pet = Pet(ownerID: UUID(), species: .dog, name: "Buddy", breed: "Shiba Inu", sex: .male)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(PetPayload.create(from: pet))) as! [String: Any]
        #expect(json["name"] as? String == "Buddy")
        #expect(json["species"] as? String == "dog")
        #expect(json["breed"] as? String == "Shiba Inu")
        #expect(json["sex"] as? String == "male")
    }
}
