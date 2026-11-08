// swift-tools-version: 6.2
//
//  LinkPreviews：ClipApp（Mac 剪贴板 App）的链接预览。从 App target 里拆出来的本地包，
//  隔离设置与 App target 一致：默认 MainActor 隔离，打开 Xcode 26「易用并发」的两项。
//

import PackageDescription

let settings: [SwiftSetting] = [
    .defaultIsolation(MainActor.self),
    .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
    .enableUpcomingFeature("InferIsolatedConformances"),
]

let package = Package(
    name: "LinkPreviews",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "LinkPreviews", targets: ["LinkPreviews"]),
    ],
    targets: [
        .target(name: "LinkPreviews", swiftSettings: settings),
        .testTarget(name: "LinkPreviewsTests", dependencies: ["LinkPreviews"], swiftSettings: settings),
    ],
    swiftLanguageModes: [.v5]
)
