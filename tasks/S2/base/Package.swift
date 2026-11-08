// swift-tools-version: 6.2
//
//  ClipData：ClipApp 的数据层。
//  @Model、唯一的写入 actor、搜索旁路索引都放在这个本地包里，保持 Swift 包默认的非 MainActor 隔离；
//  App target 仍用 Xcode 默认的 MainActor 隔离，两边只通过领域值类型与 ClipRepository 协议往来。
//

import PackageDescription

let package = Package(
    name: "ClipData",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "ClipData", targets: ["ClipData"]),
    ],
    targets: [
        .target(
            name: "ClipData",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(
            name: "ClipDataTests",
            dependencies: ["ClipData"]
        ),
    ]
)
