//
//  PPPrimaryButton.swift
//  PetBook
//
//  浅色调主按钮（胶囊形，暖橙主色 + 软阴影）。
//

import SwiftUI

struct PPPrimaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String? = nil
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: PPSpacing.sm) {
                Text(title)
                    .font(.headline)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .semibold))
                }
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(.ppPrimary, in: .capsule)
            .shadow(color: Color.ppPrimary.opacity(enabled ? 0.28 : 0), radius: 12, x: 0, y: 6)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .sensoryFeedback(.impact(weight: .light), trigger: enabled)
    }
}

struct PPSecondaryButton: View {
    let title: LocalizedStringKey
    var systemImage: String? = nil
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: PPSpacing.sm) {
                Text(title)
                    .font(.headline)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .semibold))
                }
            }
            .foregroundStyle(Color.ppTextSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(
                // 纸面感次按钮：白胶囊 + 软阴影替代 1px 描边（设计语言 v2）
                Capsule()
                    .fill(Color.ppSurface)
                    .shadow(color: .black.opacity(0.08), radius: 10, x: 0, y: 4)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

#Preview {
    VStack(spacing: 16) {
        PPPrimaryButton(title: "Continue", systemImage: "arrow.right") {}
        PPPrimaryButton(title: "Disabled", enabled: false) {}
        PPSecondaryButton(title: "Skip for now") {}
        PPSecondaryButton(title: "Disabled", enabled: false) {}
    }
    .padding(24)
    .background(Color.ppBackground)
}
