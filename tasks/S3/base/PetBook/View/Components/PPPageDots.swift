//
//  PPPageDots.swift
//  PetBook
//
//  通用分页指示器（参考别的项目的分页点）：
//  一排 Capsule 圆点，选中态拉伸成短胶囊，spring 动画。
//

import SwiftUI

struct PPPageDots: View {
    let currentIndex: Int
    let total: Int

    var activeColor: Color = .ppPrimary
    var inactiveColor: Color = .ppBorder
    var spacing: CGFloat = 6
    var activeWidth: CGFloat = 16
    var inactiveSize: CGFloat = 5

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(0..<total, id: \.self) { i in
                Capsule()
                    .fill(i == currentIndex ? activeColor : inactiveColor)
                    .frame(
                        width: i == currentIndex ? activeWidth : inactiveSize,
                        height: inactiveSize
                    )
            }
        }
        .animation(.spring(duration: 0.3), value: currentIndex)
    }
}

#Preview {
    VStack(spacing: 24) {
        PPPageDots(currentIndex: 0, total: 3)
        PPPageDots(currentIndex: 1, total: 3)
        PPPageDots(currentIndex: 2, total: 3)
    }
    .padding(40)
    .background(Color.ppBackground)
}
