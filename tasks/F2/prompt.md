在这个 SwiftUI 工程（Replica）里，照着 `materials/` 里的参照材料，复现 Trovy 的「统计报表」页，以及点进 Bedroom 后的房间详情页。

- `materials/keyframes/`：从原录屏截出的关键帧，文件名里的数字是时间点（秒）。
- `materials/timeline.md`：原录屏每一段发生了什么、什么在动、怎么动，以及页面上的全部数据。
- 图片素材已经放进 `Replica/Assets.xcassets`：房间封面 `room-bedroom`、`room-study`、`room-living`、`room-kitchen`、`room-garage`，物品图 `pen`、`charger`、`box-storage`、`sunglasses`、`hiking-headlamp`、`watch`。其余图标用 SF Symbols。

要求：

1. App 一启动就直接显示报表页，不要登录页、引导页、标签栏。
2. 静态布局、颜色、字号、间距尽量和关键帧一致，数据照 timeline.md 写死。
3. 动效和交互也要复现：数字逐位滚动、环形图点选和取消、点 Bedroom 进详情页、详情页的入场动画、左边缘右滑返回。
4. 目标设备 iPhone 18 Pro Max，最低 iOS 18，不加第三方依赖。
5. 做完确认能编译：`xcodebuild -project Replica.xcodeproj -scheme Replica -destination 'generic/platform=iOS Simulator' build`

测评时会在模拟器上按原录屏的同一套操作（固定位置的点按和滑动）播一遍并录屏，和原录屏对比静态还原、动效还原和交互手感。
