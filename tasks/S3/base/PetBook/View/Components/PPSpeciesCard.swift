//
//  PPSpeciesCard.swift
//  PetBook
//
//  Onboarding 屏 1 用的"猫/狗"大卡片选择器。
//  选中态：暖色描边发光 + 微抬升 + 主色阴影。
//

import SwiftUI

struct PPSpeciesCard: View {
    let species: Species
    let isSelected: Bool
    let action: () -> Void

    private var accentColor: Color {
        species == .cat ? .ppCat : .ppDog
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: PPSpacing.md) {
                Text(species.displayName)
                    .font(.title3)
                    .fontWeight(.semibold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
            }
            .padding(PPSpacing.xl)
            .background(isSelected ? Color.ppSurface : Color.ppSurface, in: .circle)
            .overlay(
                Circle()
                    .strokeBorder(
                        isSelected ? accentColor : Color.ppBorder,
                        lineWidth: isSelected ? 2 : 1
                    )
            )
            .shadow(
                color: isSelected ? accentColor.opacity(0.25) : Color.black.opacity(0.04),
                radius: isSelected ? 16 : 8,
                x: 0,
                y: isSelected ? 8 : 2
            )
            .scaleEffect(isSelected ? 1.1 : 1.0)
            .animation(.spring(response: 0.35, dampingFraction: 0.7), value: isSelected)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: isSelected)
    }
}

#Preview {
    HStack(spacing: 16) {
        PPSpeciesCard(species: .cat, isSelected: true) {}
        PPSpeciesCard(species: .dog, isSelected: false) {}
    }
    .padding(24)
    .background(Color.ppBackground)
}
