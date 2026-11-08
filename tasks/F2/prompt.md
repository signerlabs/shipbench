在这个 SwiftUI 工程（Replica）里，照着 `materials/reference.mp4` 这段原录屏，复现 Trovy（家庭物品管理 App）的「统计报表」页，以及点进一个房间后的详情页。

- `materials/reference.mp4`：原录屏（iPhone 18 Pro Max 模拟器，1320×2868，约 10.5 秒，无声）。
- 图片素材已经放进 `Replica/Assets.xcassets`：房间封面 `room-bedroom`、`room-study`、`room-living`、`room-kitchen`、`room-garage`，物品图 `pen`、`charger`、`box-storage`、`sunglasses`、`hiking-headlamp`、`watch`。其余图标用 SF Symbols。

要求：

1. App 一启动就直接显示报表页；不要启动页、登录页、引导页、标签栏。
2. 静态布局、颜色、字体、字号、间距和页面上的文字、数字，都尽量和原录屏一致。
3. 原录屏里的动效和交互都要复现。
4. 目标设备 iPhone 18 Pro Max，最低 iOS 18，不加第三方依赖，不联网（数据写死在 App 里）。
5. 做完确认能编译：`xcodebuild -project Replica.xcodeproj -scheme Replica -destination 'generic/platform=iOS Simulator' build`

测评时会在模拟器上按原录屏里的操作播一遍并录屏，和原录屏对比静态还原、动效还原和交互手感。
