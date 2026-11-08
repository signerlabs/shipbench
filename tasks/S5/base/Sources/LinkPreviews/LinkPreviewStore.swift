//
//  LinkPreviewStore.swift
//  LinkPreviews
//
//  链接预览（2026-10-24 产品负责人定：做，默认开，设置里可关）：链接卡片显示网页标题、站点图标与封面图。
//  卡片显示时才取（系统 LinkPresentation，从用户的 Mac 直接访问那个网站，不经任何服务器），取到的存进本机缓存目录，
//  之后不再访问；不进 SwiftData、不随 iCloud 同步，每台 Mac 各取各的。取不到的记下来，几天后再试。
//  同时最多取 3 个。
//  关掉开关即清空缓存（AppSettings.showsLinkPreviews）。
//

import AppKit
import CryptoKit
import LinkPresentation
import UniformTypeIdentifiers

/// 一条链接的预览（已解码好，可直接画）
struct LinkPreview {
    var title: String?
    var icon: NSImage?
    var image: NSImage?
}

final class LinkPreviewStore {
    static let shared = LinkPreviewStore()

    /// 解码好的预览：按像素字节计成本、总量封顶
    private let cache = NSCache<NSString, Box>()
    /// 这次运行里已知取不到的
    private var unavailable: Set<String> = []
    private var inFlight: [String: Task<LinkPreview?, Never>] = [:]
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    /// 清空后作废进行中的结果
    private var generation = 0

    private static let maxConcurrent = 3
    /// 取不到的隔这么久再试
    private static let retryInterval: TimeInterval = 3 * 86_400
    private static let directory = URL.cachesDirectory.appending(path: "LinkPreviews", directoryHint: .isDirectory)

    private final class Box {
        let preview: LinkPreview
        init(_ preview: LinkPreview) { self.preview = preview }
    }

    init() {
        cache.totalCostLimit = 30 * 1024 * 1024
    }

    /// 内存里已有的（卡片首帧直接用，不闪）
    func cached(for urlString: String) -> LinkPreview? {
        cache.object(forKey: urlString as NSString)?.preview
    }

    /// 取预览：先查内存、再查磁盘，都没有才访问网站；不该访问或取不到返回 nil
    func preview(for urlString: String) async -> LinkPreview? {
        if let hit = cached(for: urlString) { return hit }
        guard !unavailable.contains(urlString), let url = Self.fetchableURL(urlString) else { return nil }
        if let task = inFlight[urlString] { return await task.value }
        let currentGeneration = generation
        let task = Task { await load(url, key: urlString) }
        inFlight[urlString] = task
        let result = await task.value
        inFlight[urlString] = nil
        guard currentGeneration == generation else { return nil }
        if let result {
            cache.setObject(Box(result), forKey: urlString as NSString, cost: Self.cost(of: result))
        } else {
            unavailable.insert(urlString)
        }
        return result
    }

    /// 关掉链接预览时：清掉内存与磁盘里取过的全部预览
    func removeAll() {
        generation += 1
        cache.removeAllObjects()
        unavailable.removeAll()
        let directory = Self.directory
        Task.detached(priority: .utility) {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    // MARK: - 取

    private func load(_ url: URL, key: String) async -> LinkPreview? {
        let file = Self.directory.appending(path: Self.fileName(for: key))
        if let stored = await Self.read(file), !stored.isEmpty || Date.now.timeIntervalSince(stored.fetchedAt) < Self.retryInterval {
            return await Self.decode(stored)
        }
        await acquire()
        defer { release() }
        let currentGeneration = generation
        let stored = await Self.fetch(url)
        // 取的过程中用户关掉了预览：不落盘
        guard currentGeneration == generation else { return nil }
        await Self.write(stored, to: file)
        return await Self.decode(stored)
    }

    private func acquire() async {
        if running < Self.maxConcurrent {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty {
            running -= 1
        } else {
            waiters.removeFirst().resume()
        }
    }

    /// 能不能访问：只取 http / https 网址
    nonisolated static func fetchableURL(_ string: String) -> URL? {
        guard let url = URL(string: string),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host(percentEncoded: false), !host.isEmpty
        else { return nil }
        return url
    }

    // MARK: - 磁盘缓存

    /// 存在磁盘上的一条：图片是已缩好的 PNG；三样都没有 = 取不到
    nonisolated private struct StoredPreview: Codable, Sendable {
        var title: String?
        var icon: Data?
        var image: Data?
        var fetchedAt: Date

        var isEmpty: Bool { title == nil && icon == nil && image == nil }
    }

    nonisolated private static func fileName(for key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined() + ".plist"
    }

    nonisolated private static func read(_ file: URL) async -> StoredPreview? {
        await Task.detached(priority: .userInitiated) {
            guard let data = try? Data(contentsOf: file) else { return nil }
            return try? PropertyListDecoder().decode(StoredPreview.self, from: data)
        }.value
    }

    nonisolated private static func write(_ stored: StoredPreview, to file: URL) async {
        await Task.detached(priority: .utility) {
            let encoder = PropertyListEncoder()
            encoder.outputFormat = .binary
            guard let data = try? encoder.encode(stored) else { return }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }.value
    }

    // MARK: - 访问网站

    nonisolated private static func fetch(_ url: URL) async -> StoredPreview {
        let provider = LPMetadataProvider()
        provider.timeout = 10
        guard let metadata = try? await provider.startFetchingMetadata(for: url) else {
            return StoredPreview(fetchedAt: .now)
        }
        let title = metadata.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let iconProvider = metadata.iconProvider
        let imageProvider = metadata.imageProvider
        let icon = await imageData(from: iconProvider, maxPixelSize: 96)
        let image = await imageData(from: imageProvider, maxPixelSize: 640)
        return StoredPreview(title: title?.isEmpty == false ? title : nil, icon: icon, image: image, fetchedAt: .now)
    }

    /// 从系统给的图片取原始字节，缩成卡片用的大小（PNG）
    nonisolated private static func imageData(from provider: NSItemProvider?, maxPixelSize: Int) async -> Data? {
        guard let provider,
              let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true })
        else { return nil }
        let data: Data? = await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
        return data.flatMap { ImageProcessing.thumbnail(from: $0, maxPixelSize: maxPixelSize) }
    }

    // MARK: - 解码

    /// 后台解码成位图（画到屏幕上不再在主线程解码）；三样都没有返回 nil
    nonisolated private static func decode(_ stored: StoredPreview) async -> LinkPreview? {
        guard !stored.isEmpty else { return nil }
        return await Task.detached(priority: .userInitiated) {
            func image(_ data: Data?, _ maxPixelSize: Int) -> NSImage? {
                guard let data, let cgImage = ThumbnailDecoder.downsample(data, maxPixelSize: maxPixelSize) else { return nil }
                return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
            }
            return LinkPreview(title: stored.title, icon: image(stored.icon, 64), image: image(stored.image, 440))
        }.value
    }

    private static func cost(of preview: LinkPreview) -> Int {
        [preview.icon, preview.image].compactMap { $0 }.reduce(0) { total, image in
            total + Int(image.size.width * image.size.height * 4)
        }
    }
}
