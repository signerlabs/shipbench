在这个 SwiftUI 工程（Replica）里，照着 `materials/reference.mp4` 这段原录屏，复现烟火小店（美食地图 App）的首页。

- `materials/reference.mp4`：原录屏（iPhone 18 Pro Max 模拟器，1320×2868，约 12.4 秒，无声）。
- `materials/fonts/`：页面用到的五款字体文件（OFL 协议），要在 App 里用上。
- 图片素材已经放进 `Replica/Assets.xcassets`：店铺照片 `shop-dabanlou`、`shop-vea`、`shop-hongmian`、`shop-mingfa`、`shop-dali`、`shop-amber`、`shop-fulin`、`shop-linji`、`shop-xinguixiang`、`shop-beiyuan`；推荐者头像 `avatar-wulala`、`avatar-reiko`、`avatar-jason`、`avatar-fengwei`；图标 `icon-search`、`icon-city`、`icon-push-pin`、`icon-thumbs-up`；标签栏图标 `tab-home`、`tab-map`、`tab-profile`（选中态）和 `tab-home-off`、`tab-map-off`、`tab-profile-off`（未选中态）。其余图标用 SF Symbols。

要求：

1. App 一启动就直接显示首页；不要启动页、登录页、引导页。
2. 静态布局、颜色、字体、字号、间距和页面上的文字，都尽量和原录屏一致。
3. 原录屏里的动效和交互都要复现。
4. 目标设备 iPhone 18 Pro Max，最低 iOS 18，不加第三方依赖，不联网（数据写死在 App 里）。
5. 做完确认能编译：`xcodebuild -project Replica.xcodeproj -scheme Replica -destination 'generic/platform=iOS Simulator' build`

测评时会在模拟器上按原录屏里的操作播一遍并录屏，和原录屏对比静态还原、动效还原和交互手感。
