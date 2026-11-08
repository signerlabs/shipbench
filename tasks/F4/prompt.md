在这个 SwiftUI 工程（Replica）里，照着 `materials/reference.mp4` 这段原录屏，复现 Moonlitt（月相 App）的主界面。

- `materials/reference.mp4`：原录屏（在 iPhone 真机上录的，1290×2796，约 7.3 秒，无声）。
- 工程里的 `Replica/Assets.xcassets` 是空的，不提供任何图片素材。

要求：

1. App 一启动就直接显示这一页；不要启动页、登录页、引导页。
2. 静态布局、颜色、字号、间距和页面上的文字，都尽量和原录屏一致。不提供图片素材：照片、插画、角色和图标用 SF Symbols 和占位图形（色块、渐变、简单形状）代替，位置、大小、颜色尽量接近原录屏。
3. 原录屏里的动效和交互都要复现。
4. 目标设备 iPhone 18 Pro Max，最低 iOS 18，不加第三方依赖，不联网（数据写死在 App 里）。
5. 做完确认能编译：`xcodebuild -project Replica.xcodeproj -scheme Replica -destination 'generic/platform=iOS Simulator' build`

测评时会在模拟器上按原录屏里的操作播一遍并录屏，和原录屏对比静态还原、动效还原和交互手感。
