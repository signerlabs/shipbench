//
//  PPSegmentChip.swift
//  PetBook
//
//  通用分段胶囊单选按钮。caller 端通过 isSelected 标记选中态，HStack 内并排即得
//  segmented control 风格。title 是 String（caller 常传 enum.displayName 等运行时本地化结果）。
//

import SwiftUI

struct PPSegmentChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.footnote)
                .fontWeight(.medium)
                .foregroundStyle(isSelected ? .white : Color.ppTextPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(
                    Capsule().fill(isSelected ? Color.ppPrimary : Color.ppSurface)
                )
                .overlay(
                    Capsule().strokeBorder(
                        isSelected ? Color.clear : Color.ppBorder,
                        lineWidth: 1
                    )
                )
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: isSelected)
    }
}

#Preview("Single row") {
    @Previewable @State var selected: String = "Yes"

    VStack(alignment: .leading, spacing: 24) {
        Text("Sterilized?")
            .font(.caption)
            .foregroundStyle(Color.ppTextSecondary)

        HStack(spacing: 8) {
            ForEach(["Yes", "No", "Don't know"], id: \.self) { option in
                PPSegmentChip(
                    title: option,
                    isSelected: selected == option
                ) {
                    selected = option
                }
            }
        }

        Text("Sex (2 options)")
            .font(.caption)
            .foregroundStyle(Color.ppTextSecondary)

        HStack(spacing: 8) {
            PPSegmentChip(title: "Male", isSelected: true) {}
            PPSegmentChip(title: "Female", isSelected: false) {}
        }
    }
    .padding(24)
    .background(Color.ppBackground)
}
