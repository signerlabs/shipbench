//
//  PPComingSoonPlaceholder.swift
//  PetBook
//
//  骨架阶段的"Coming soon"空白占位。
//

import SwiftUI

struct PPComingSoonPlaceholder: View {
    let symbol: String
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey

    var body: some View {
        VStack(spacing: PPSpacing.lg) {
            Image(systemName: symbol)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Color.ppPrimary.opacity(0.5))
                .padding(28)
                .background(Circle().fill(Color.ppSurface))

            VStack(spacing: PPSpacing.sm) {
                Text(title)
                    .font(.title2)
                    .fontWeight(.semibold)
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.ppTextPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.ppTextSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, PPSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.ppBackground)
    }
}

#Preview {
    PPComingSoonPlaceholder(
        symbol: "house",
        title: "Home",
        subtitle: "Today's reminders, compliance cards, and PALS helper will live here."
    )
}
