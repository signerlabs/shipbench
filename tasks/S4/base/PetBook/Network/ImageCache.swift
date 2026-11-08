//
//  ImageCache.swift
//  PetBook
//
//  通用远程图片双层缓存：NSCache 内存层（进程内、收到内存压力自动清）+ caches 目录磁盘层（跨启动持久）。
//
//  ★ key 必须用「稳定标识」——本项目用后端 object path（photo_path，如 {owner}/{pet}.jpg）。
//    绝不能用 signed URL 当 key：signed URL 每次签名都带新 token / 过期时间，是变的，当 key 会永远 miss。
//
//  读路径（image(forKey:)）同步：先查内存命中即返回；内存 miss 查磁盘，磁盘命中则载入内存再返回。
//  这让 PPPetAvatar 能在 init/首帧同步拿到缓存图，根本不出现 emoji→真图的闪烁。
//

import UIKit

final class ImageCache {

    static let shared = ImageCache()

    /// 内存层。键用 NSString（NSCache 要求 class 类型 key）。
    private let memory = NSCache<NSString, UIImage>()

    /// 磁盘层目录：caches/ImageCache（caches 目录系统可在空间紧张时回收，符合「缓存可重建」语义）。
    private let diskDirectory: URL

    /// 串行队列保护磁盘写（读用同步 Data(contentsOf:)，写异步入队，避免阻塞调用线程）。
    private let ioQueue = DispatchQueue(label: "com.example.PetBook.ImageCache.io")

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        diskDirectory = caches.appendingPathComponent("ImageCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: diskDirectory, withIntermediateDirectories: true)
    }

    // MARK: - 读（同步）

    /// 同步取缓存图：内存命中直接返回；内存 miss 查磁盘，磁盘命中则回填内存再返回；都 miss → nil。
    /// 供 PPPetAvatar 在首帧同步调用，命中即首帧渲染真图（无 emoji 闪烁）。
    func image(forKey key: String) -> UIImage? {
        let nsKey = key as NSString
        if let cached = memory.object(forKey: nsKey) {
            return cached
        }
        // 内存 miss → 查磁盘（同步小文件读，头像 JPEG 体积小，可接受）
        let fileURL = diskFileURL(forKey: key)
        guard let data = try? Data(contentsOf: fileURL),
              let image = UIImage(data: data) else {
            return nil
        }
        // 磁盘命中 → 回填内存，下次首帧直接内存命中
        memory.setObject(image, forKey: nsKey)
        return image
    }

    // MARK: - 写

    /// 存图：同步写内存（立即对后续 image(forKey:) 可见）+ 异步写磁盘（不阻塞调用线程）。
    func store(_ image: UIImage, forKey key: String) {
        memory.setObject(image, forKey: key as NSString)

        let fileURL = diskFileURL(forKey: key)
        ioQueue.async {
            // 用 JPEG 落盘（头像统一 JPEG，体积小）；写失败静默——磁盘层是优化非真相，下次重下即可
            if let data = image.jpegData(compressionQuality: 0.9) {
                try? data.write(to: fileURL, options: .atomic)
            }
        }
    }

    // MARK: - 失效

    /// 移除某 key 的内存 + 磁盘缓存。
    /// 用于「换图后 photo_path 不变」场景（upsert 覆盖，路径仍是 {owner}/{pet}.jpg）：
    /// 必须先清旧缓存再存新图，否则首帧同步命中会显示旧图。
    func remove(forKey key: String) {
        memory.removeObject(forKey: key as NSString)
        let fileURL = diskFileURL(forKey: key)
        ioQueue.async {
            try? FileManager.default.removeItem(at: fileURL)
        }
    }

    // MARK: - 磁盘文件名

    /// 把 key（含 "/" 的 object path）转成安全的扁平文件名。
    /// "/" 不能直接做文件名（会被当目录分隔），统一替换为 "_"；再裹一层避免极端字符。
    private func diskFileURL(forKey key: String) -> URL {
        let safeName = key
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return diskDirectory.appendingPathComponent(safeName)
    }
}
