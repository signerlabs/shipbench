在这个 SwiftUI 工程（Replica）里，照着 `materials/reference.mp4` 这段原录屏，复现烟火小店（美食地图 App）的新用户引导页：三步讲解，每一步都有插画动画。

- `materials/reference.mp4`：原录屏（iPhone 18 Pro Max 模拟器，1320×2868，约 14.5 秒，无声）：从第 1 步开演，点两次底部的「下一步」，一直到第 3 步演完。
- `materials/fonts/`：页面用到的三款字体文件（OFL 协议），要在 App 里用上。
- 图片素材已经放进 `Replica/Assets.xcassets`：推荐者头像 `welcome-suipo`、`welcome-wulala`、`welcome-jason`，插画 `welcome-noodles`、`welcome-map`、`welcome-shop`，图标 `icon-flame`、`icon-pin`、`icon-pin-red`、`icon-paper-plane`。其余图标用 SF Symbols。

要求：

1. App 一启动就直接显示引导页第 1 步，并且马上开演第 1 步的动画；不要启动页、登录页、标签栏。
2. 静态布局、颜色、字体、字号、间距和页面上的文字，都尽量和原录屏一致。
3. 原录屏里的动效和交互都要复现。
4. 目标设备 iPhone 18 Pro Max，最低 iOS 18，不加第三方依赖。
5. 做完确认能编译：`xcodebuild -project Replica.xcodeproj -scheme Replica -destination 'generic/platform=iOS Simulator' build`

测评时会在模拟器上按原录屏的同一套操作（启动后等待，在屏幕底部「下一步」按钮的位置点按两次）播一遍并录屏，和原录屏对比静态还原、动效还原和交互手感。
