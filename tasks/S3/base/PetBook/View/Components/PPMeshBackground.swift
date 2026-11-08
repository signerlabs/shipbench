//
//  PPMeshBackground.swift
//  PetBook
//
//  动态流动渐变背景 — 和谐暖色系。**控制点 / 光斑位置固定（形状不变）**，
//  只让颜色在两组和谐 palette 间平滑往复插值，呈现"颜色缓缓流动但形状不扭动"的效果。
//  iOS 18+ 用原生 MeshGradient；iOS 17 用固定位置 RadialGradient 光斑。纯 SwiftUI，零依赖。
//

import SwiftUI

struct PPMeshBackground: View {
    /// 颜色流动速度倍率。
    var speed: Double = 0.35

    private typealias RGB = (r: Double, g: Double, b: Double)

    // 和谐暖色系（低饱和浅色，深色文字可读）
    private static let coral: RGB = (1.00, 0.84, 0.74)
    private static let cream: RGB = (1.00, 0.96, 0.91)
    private static let mint:  RGB = (0.84, 0.95, 0.90)
    private static let lilac: RGB = (0.90, 0.85, 0.99)
    private static let peach: RGB = (1.00, 0.90, 0.81)

    // 两组 palette（同 5 色不同排布），9 个点各自在 A[i]↔B[i] 间往复 → 只流动颜色
    private static let paletteA: [RGB] = [coral, cream, mint, peach, lilac, coral, mint, peach, cream]
    private static let paletteB: [RGB] = [peach, mint, cream, lilac, coral, peach, cream, mint, lilac]

    // 固定的 3×3 均匀网格控制点 — 形状不随时间变。
    private static let fixedPoints: [SIMD2<Float>] = [
        SIMD2(0, 0),   SIMD2(0.5, 0),   SIMD2(1, 0),
        SIMD2(0, 0.5), SIMD2(0.5, 0.5), SIMD2(1, 0.5),
        SIMD2(0, 1),   SIMD2(0.5, 1),   SIMD2(1, 1)
    ]

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate * speed
            gradient(meshColors(t), t)
        }
    }

    /// 9 个点的颜色随 t 在两组 palette 间平滑往复。
    private func meshColors(_ t: TimeInterval) -> [Color] {
        (0..<9).map { i in
            let f = (sin(t + Double(i) * 0.6) + 1) / 2
            return lerp(Self.paletteA[i], Self.paletteB[i], f)
        }
    }

    private func lerp(_ a: RGB, _ b: RGB, _ f: Double) -> Color {
        Color(.sRGB,
              red: a.r + (b.r - a.r) * f,
              green: a.g + (b.g - a.g) * f,
              blue: a.b + (b.b - a.b) * f)
    }

    @ViewBuilder
    private func gradient(_ colors: [Color], _ t: TimeInterval) -> some View {
        if #available(iOS 18.0, *) {
            MeshGradient(
                width: 3,
                height: 3,
                points: Self.fixedPoints,    // 固定，不漂移
                colors: colors               // 仅颜色流动
            )
        } else {
            fallback(colors)
        }
    }

    // MARK: - iOS 17 fallback：固定位置光斑，仅颜色变化

    private func fallback(_ colors: [Color]) -> some View {
        GeometryReader { proxy in
            let w = proxy.size.width
            let h = proxy.size.height
            ZStack {
                colors[4]  // 中心色作底

                blob(colors[0], x: 0.22, y: 0.22, r: w * 0.6, w: w, h: h)
                blob(colors[2], x: 0.80, y: 0.25, r: w * 0.55, w: w, h: h)
                blob(colors[6], x: 0.25, y: 0.80, r: w * 0.6, w: w, h: h)
                blob(colors[8], x: 0.80, y: 0.80, r: w * 0.55, w: w, h: h)
            }
        }
    }

    private func blob(_ color: Color, x: Double, y: Double, r: CGFloat, w: CGFloat, h: CGFloat) -> some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [color, color.opacity(0)],
                    center: .center,
                    startRadius: 0,
                    endRadius: r
                )
            )
            .frame(width: r * 2, height: r * 2)
            .position(x: w * x, y: h * y)
            .blendMode(.plusLighter)
    }
}

#Preview {
    PPMeshBackground()
        .ignoresSafeArea()
}
