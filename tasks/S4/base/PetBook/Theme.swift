//
//  Theme.swift
//  PetBook
//
//  PetBook 非颜色 design tokens（spacing / radius / typography）。
//  颜色全部走 Assets.xcassets 的 colorset，Xcode 自动生成 `Color.ppXxx` 强类型属性，
//  代码里直接 `.ppPrimary` / `Color.ppBackground` 即可，无需 Color("name") 字符串包装。
//

import SwiftUI

// MARK: - Spacing

enum PPSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let xxxl: CGFloat = 48
}

// MARK: - Radius

enum PPRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let pill: CGFloat = 999
}
