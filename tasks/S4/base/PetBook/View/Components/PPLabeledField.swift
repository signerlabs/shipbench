//
//  PPLabeledField.swift
//  PetBook
//
//  通用表单字段包装：上方一行 label（可选 required 红星 + hint 副说明），
//  下方为 content（任意输入控件），content 自带白卡片 + ppBorder 描边样式。
//

import SwiftUI

struct PPLabeledField<Content: View>: View {
    let label: LocalizedStringKey
    var hint: LocalizedStringKey? = nil
    var required: Bool = false
    /// false 时 content 不套白卡（无边框 / 无内边距），只在 label 下裸放内容（如 segmented chips）。
    var bordered: Bool = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: PPSpacing.xs) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(Color.ppTextSecondary)
                if required {
                    Text("*")
                        .font(.caption)
                        .foregroundStyle(Color.ppPrimary)
                }
            }

            if bordered {
                content()
                    .foregroundStyle(Color.ppTextPrimary)
                    .padding(.horizontal, PPSpacing.md)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                            .fill(Color.ppSurface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: PPRadius.md, style: .continuous)
                            .strokeBorder(Color.ppBorder, lineWidth: 1)
                    )
            } else {
                content()
            }

            if let hint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(Color.ppTextSecondary)
            }
        }
    }
}

#Preview("Variants") {
    VStack(spacing: 16) {
        PPLabeledField(label: "Name") {
            TextField("e.g. Mochi", text: .constant(""))
        }
        PPLabeledField(label: "Microchip ID", hint: "15 digits") {
            TextField("e.g. 900164001234567", text: .constant("900164001234567"))
                .keyboardType(.numberPad)
        }
        PPLabeledField(label: "Sterilized", hint: "Affects license fees", required: true) {
            TextField("", text: .constant("Yes"))
        }
        PPLabeledField(label: "Breed", required: true) {
            Text("Golden Retriever")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    .padding(24)
    .background(Color.ppBackground)
}
