# Sprout iOS 项目约定

- SwiftUI，最低 iOS 18。不写 iOS 18 及以下的 #available / @available 兼容分支。
- UI 优先用 ShipSwift 组件：源码在 Sprout/ShipSwift/（类型以 SW 开头，修饰符以 .sw 开头）。组件库没有对应能力时才自己写。
- 动手前先在 docs/shipswift/index.md 找到对应的组件文档，完整读一遍（Overview、Usage、Integration Checklist、Pitfalls / Gotchas）再写代码；按文档的 Integration Checklist 补齐配置。
- 写或改 SwiftUI 前先读 docs/swiftui-notes.md。文档里写明的坑一律不许踩。
- 直接引用 Sprout/ShipSwift/ 里已有的文件，不复制、不改名、不改实现；文档明确允许改的配置点（枚举、网址、文案）可以改。
- 不引入第三方依赖（SPM / CocoaPods），不改工程的构建设置。
- 不要 git push，不要删除文件，不要读写任何密钥。
- 交付前必须通过：xcodebuild -scheme Sprout -destination 'generic/platform=iOS Simulator' build
