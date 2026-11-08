//
//  PetHeroCard.swift
//  PetBook
//
//  宠物详情页 hero：可 3D 立体转动的宠物卡片（1:1 正方形）。拖拽卡片 → 随手指绕 X/Y 轴
//  倾斜旋转（像把玩一张实体卡），松手 spring 回正。宠物图片填满整张卡，name + 副标题
//  （物种·品种·年龄）overlay 在左下角，底部暗化渐变 + 文字阴影保证白字在照片 / 米白
//  emoji 卡上都可读。
//
//  图片来源：复用 PPPetAvatar 同款 PetPhotoLayer（远程照片 signed URL + ImageCache 消闪、
//  本地 Asset、物种 emoji 兜底三态，单一真相）——头像能显示的真图，hero 卡片同样显示。
//

import SwiftUI

struct PetHeroCard: View {
    let pet: Pet
    /// 副标题文案（物种 · 品种 · 年龄），由 PetDetailView 计算后传入。
    let subtitle: String

    /// 最大倾斜角度（度）：拖到边缘时卡片绕轴旋转的上限，越大越夸张。
    private let maxTilt: Double = 16
    /// 位移→角度灵敏度：拖动 sensitivity 点对应 maxTilt 角度（越小越灵敏）。
    private let sensitivity: CGFloat = 120

    /// 当前拖拽位移（pt），onChanged 实时更新，松手 spring 回 .zero。
    @State private var drag: CGSize = .zero

    /// 物种色环：猫用 ppCat，狗用 ppDog（与 PPPetAvatar 同款语义）。
    private var ring: Color { pet.species == .cat ? .ppCat : .ppDog }

    var body: some View {
        // 卡片底用 ppSurface 正方形（撑满宽度的 1:1）作布局基准——图片 / 渐变 / 文字都用
        // overlay 叠在这个固定正方形上。overlay 永远不改变底视图尺寸，文字定位只依赖底的
        // 正方形、与图片 scaledToFill 无关，从根上杜绝「图片撑大布局把文字挤出卡外」。
        Color.ppSurface
            .aspectRatio(1, contentMode: .fit)
            // 1) 宠物图片填满正方形 + clipped 裁掉 scaledToFill 溢出（远程/本地/emoji 见 PetPhotoLayer）
            .overlay {
                PetPhotoLayer(pet: pet, emojiSize: 120)
                    .clipped()
            }
            // 2) 底部暗化渐变：保证白字在照片 / 米白 emoji 卡上都可读
            .overlay {
                LinearGradient(
                    colors: [.clear, .black.opacity(0.55)],
                    startPoint: .center,
                    endPoint: .bottom
                )
            }
            // 3) name + 副标题：独立 overlay 锚到正方形左下角（不受图片层影响）
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: PPSpacing.xs) {
                    Text(pet.name)
                        .font(.title)
                        .fontWeight(.bold)
                        .fontDesign(.rounded)
                    Text(subtitle)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .opacity(0.92)
                }
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.4), radius: 4, x: 0, y: 1)
                .padding(PPSpacing.lg)
            }
            .clipShape(RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous)
                    .strokeBorder(ring.opacity(0.5), lineWidth: 1.5)
            )
            .shadow(color: .black.opacity(0.18), radius: 18, x: 0, y: 10)
            .contentShape(RoundedRectangle(cornerRadius: PPRadius.xl, style: .continuous))
            // 立体转动：水平拖 → 绕 Y 轴，垂直拖 → 绕 X 轴（下拖时顶部后仰，符合直觉）。
            // perspective 越小透视形变越强，0.5 给明显的实体卡片立体感。
            .rotation3DEffect(.degrees(tiltY), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
            .rotation3DEffect(.degrees(tiltX), axis: (x: 1, y: 0, z: 0), perspective: 0.5)
            // ScrollView 会吞掉子视图的 .gesture(DragGesture)，故用 simultaneousGesture 与滚动并存：
            // 拖动卡片即驱动 3D 倾斜，松手 spring 回正（不阻断页面纵向滚动）。
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { drag = $0.translation }
                    .onEnded { _ in
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) {
                            drag = .zero
                        }
                    }
            )
    }

    // MARK: 倾斜角度（按拖拽量比例，clamp 到 ±maxTilt）

    private var tiltY: Double {  clampedAngle(Double(drag.width  / sensitivity) * maxTilt) }
    private var tiltX: Double { -clampedAngle(Double(drag.height / sensitivity) * maxTilt) }

    private func clampedAngle(_ raw: Double) -> Double { min(max(raw, -maxTilt), maxTilt) }
}

#Preview {
    ScrollView {
        VStack(spacing: PPSpacing.xl) {
            ForEach(Pet.mocks) { pet in
                PetHeroCard(
                    pet: pet,
                    subtitle: [pet.species.displayName, pet.breed].compactMap { $0 }.joined(separator: " · ")
                )
            }
        }
        .padding(PPSpacing.xl)
    }
    .background(Color.ppBackground)
    .environment(PetBookStore())
}
