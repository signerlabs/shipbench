//
//  PPPetAvatar.swift
//  PetBook
//
//  公共宠物头像组件：圆形 surface 底 + 物种色环（猫 ppCat / 狗 ppDog）+ 居中物种 emoji。
//  Pets 列表、Pet 详情 hero 等多处复用；size 参数控制直径（默认 52）。
//
//  三种显示来源（按优先级）：
//    1) 远程照片（network 模式 + photoAssetName 是后端 object path，含 "/"）：
//       ★ init 时同步查 ImageCache(key = photo_path) —— 命中则 image 初值即真图，首帧渲染就是照片、
//         根本不出现 emoji 闪烁；未命中才在 .task 异步拉 signed URL → 下载 → 存缓存 → 刷新。
//    2) 本地 Asset（photoAssetName 不含 "/"，如 mock 的 "pet-mochi"）：Image(asset)。
//    3) 兜底：surface 底 + 物种 emoji（仅全新首次加载有一次 emoji→真图过渡，要下载，不可避免）。
//
//  圆形是显示层 clipShape，与存储原图无关：将来改方形只动 clipShape 一行。
//

import SwiftUI
import UIKit

/// PPPetAvatar 的 .task 触发 key：photo_path（首挂载 / 切换 pet）+ photoVersion（换图）任一变化都重跑。
private struct AvatarTaskKey: Equatable {
    let path: String?
    let version: Int
}

struct PPPetAvatar: View {
    enum Style {
        case circle(diameter: CGFloat = 52)
        case rounded(width: CGFloat, height: CGFloat, cornerRadius: CGFloat = PPRadius.lg)
    }

    let pet: Pet
    var style: Style = .circle()
    var shakes: Bool = false

    /// 物种色环：猫用 ppCat，狗用 ppDog
    private var ring: Color { pet.species == .cat ? .ppCat : .ppDog }

    var body: some View {
        let avatar = avatarContent
        if shakes {
            PhaseAnimator(ShakePhase.allCases) { phase in
                avatar
                    .scaleEffect(phase.scale)
                    .rotationEffect(.degrees(phase.rotation))
            } animation: { phase in
                phase.animation
            }
        } else {
            avatar
        }
    }

    @ViewBuilder
    private var avatarContent: some View {
        switch style {
        case .circle(let diameter):
            PetPhotoLayer(pet: pet, emojiSize: diameter * 0.5)
                .frame(width: diameter, height: diameter)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(ring, lineWidth: 2))

        case .rounded(let width, let height, let cornerRadius):
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            PetPhotoLayer(pet: pet, emojiSize: min(width, height) * 0.4)
                .frame(width: width, height: height)
                .clipShape(shape)
                .overlay(shape.strokeBorder(ring, lineWidth: 2))
        }
    }

    init(pet: Pet, size: CGFloat = 52) {
        self.pet = pet
        self.style = .circle(diameter: size)
    }

    init(pet: Pet, width: CGFloat, height: CGFloat, cornerRadius: CGFloat = PPRadius.lg, shakes: Bool = false) {
        self.pet = pet
        self.style = .rounded(width: width, height: height, cornerRadius: cornerRadius)
        self.shakes = shakes
    }
}

// MARK: - Shake animation phases

private enum ShakePhase: CaseIterable {
    case idle, zoomIn
    case shake1L, shake1R, shake2L, shake2R, shake3L, shake3R
    case zoomOut

    var scale: Double {
        switch self {
        case .idle, .zoomOut: 1.0
        case .zoomIn, .shake1L, .shake1R, .shake2L, .shake2R, .shake3L, .shake3R: 1.1
        }
    }

    var rotation: Double {
        switch self {
        case .idle, .zoomIn, .zoomOut: 0
        case .shake1L: -4
        case .shake1R: 4
        case .shake2L: -6
        case .shake2R: 6
        case .shake3L: -4
        case .shake3R: 4
        }
    }

    var animation: Animation {
        switch self {
        case .idle: .easeInOut(duration: 0.01)
        case .zoomIn: .easeInOut(duration: 0.2).delay(1.5)
        case .shake1L, .shake1R, .shake2L, .shake2R, .shake3L, .shake3R: .easeInOut(duration: 0.08)
        case .zoomOut: .easeInOut(duration: 0.2)
        }
    }
}

// MARK: - 宠物图片填充层（圆形头像 + trading-card hero 共用）

/// 宠物图片填充层（无形状裁剪 / 无边框）：远程照片（signed URL + ImageCache 首帧消闪）
/// → 本地 Asset → 物种 emoji 兜底。圆形头像（`PPPetAvatar`）与详情页 trading-card hero
/// （`PetHeroCard`）共用此层 —— 图片来源是单一真相，避免两处各写一份远程加载逻辑。
/// 调用方负责裁剪形状 / frame；emoji 兜底字号由 `emojiSize` 传入（头像 size*0.5，hero 用大字号）。
struct PetPhotoLayer: View {
    let pet: Pet
    /// emoji 兜底字号（无照片时居中显示的物种 emoji）。
    var emojiSize: CGFloat = 26

    @Environment(PetBookStore.self) private var store

    /// 远程照片字节。init 时同步从 ImageCache 取初值：命中 → 首帧即真图（无 emoji 闪烁）。
    @State private var image: UIImage?

    init(pet: Pet, emojiSize: CGFloat = 26) {
        self.pet = pet
        self.emojiSize = emojiSize
        // ★ 首帧消闪：远程照片在 init 同步查内存/磁盘缓存，命中即作为 @State 初值
        if let path = Self.remotePath(of: pet) {
            _image = State(initialValue: ImageCache.shared.image(forKey: path))
        } else {
            _image = State(initialValue: nil)
        }
    }

    /// pet 的远程 object path（含 "/" 才是远程；本地 Asset 名不含 "/"）。
    private static func remotePath(of pet: Pet) -> String? {
        guard let p = pet.photoAssetName, p.contains("/") else { return nil }
        return p
    }

    private var hasRemotePhoto: Bool { Self.remotePath(of: pet) != nil }

    var body: some View {
        ZStack {
            if let image {
                // 远程照片字节已就绪（缓存命中或已下载）
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let asset = pet.photoAssetName, !hasRemotePhoto {
                // 本地 Asset（mock）
                Image(asset)
                    .resizable()
                    .scaledToFill()
            } else {
                // 兜底：surface + 物种 emoji（无照片，或远程照片首次下载中）
                ZStack {
                    Color.ppSurface
                    Text(pet.species.emoji)
                        // emoji 固定字号例外：需精确填充容器中心
                        .font(.system(size: emojiSize))
                }
            }
        }
        // 远程照片加载触发器：photoAssetName 变化（首挂载 / 不同 pet）或 photoVersion 变化（换图）都重跑。
        // 换图后 path 不变、靠 photoVersion 自增驱动重载，去取换图时已存入的新缓存。
        .task(id: AvatarTaskKey(path: pet.photoAssetName, version: store.photoVersion[pet.id] ?? 0)) {
            await loadRemoteIfNeeded()
        }
    }

    /// 远程照片加载：先同步查缓存（命中即用最新缓存，覆盖可能的旧图——换图场景关键）；
    /// 缓存 miss 才拉 signed URL → 下载 → 存缓存 → 设 image。
    private func loadRemoteIfNeeded() async {
        guard let path = Self.remotePath(of: pet) else {
            image = nil   // pet 切换到无远程照片（理论少见）→ 退兜底
            return
        }

        // 先查缓存：命中即用（换图后这里命中的是刚存入的新图，确保不显示旧图）
        if let cached = ImageCache.shared.image(forKey: path) {
            image = cached
            return
        }

        // 缓存 miss → 拉 signed URL（store 内按 photo_path 做 TTL 复用，不会每次重签）
        guard let urlString = await store.remotePhotoURL(for: pet),
              let url = URL(string: urlString) else { return }

        // 下载字节（零依赖 URLSession）
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              let downloaded = UIImage(data: data) else { return }

        // 存缓存（key = 稳定 photo_path）+ 刷新 UI
        ImageCache.shared.store(downloaded, forKey: path)
        image = downloaded
    }
}

#Preview {
    VStack(spacing: 24) {
        HStack(spacing: 16) {
            ForEach(Pet.mocks) { pet in
                PPPetAvatar(pet: pet)
            }
            PPPetAvatar(pet: Pet.mocks[0], size: 80)
        }
        HStack(spacing: 16) {
            PPPetAvatar(pet: Pet.mocks[0], width: 80, height: 80)
            PPPetAvatar(pet: Pet.mocks[1], width: 120, height: 80, cornerRadius: 16)
            PPPetAvatar(pet: Pet.mocks[2], width: 60, height: 80, cornerRadius: 8)
        }
    }
    .padding(24)
    .background(Color.ppBackground)
    .environment(PetBookStore())
}
