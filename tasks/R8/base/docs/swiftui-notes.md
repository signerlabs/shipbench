# SwiftUI / iOS 踩坑笔记（各 iOS 项目共用）

> 从 `某项目` 迁出的按需文档（2026-10-05），与 `aws-notes.md` / `cf-notes.md` 同款模式：**写 / 改 SwiftUI 前必读**。只收与具体项目无关的通用坑；项目特有的（自家组件的用法、模型约定）仍记在各自 CLAUDE.md。新踩到的通用坑追加到对应小节，括注出处项目。运行 App 与看日志的做法见用户级 `~/.claude/CLAUDE.md`「iOS 运行与日志」。

## 编译与工具

- 批量加文件后 SourceKit 报「Cannot find X in scope」多是假阳性，先 build 再判断；模型改了存储字段后出怪崩溃，先 clean build
- ViewBuilder 漏括号会报一串难懂的类型错误；`withAnimation { set.insert(x) }` 因返回值报泛型冲突，写 `_ = set.insert(x)`
- `case a, b where cond` 的 where 只约束最后一个 pattern
- Xcode 预览起不来而 App 能编过，先看预览 thunk 的编译诊断（字面量被替换成 `__designTime*`）
- 引入 SwiftData：每个用到其 API 的文件都要 `import SwiftData`（含只用 `.modelContainer` 的）
- 默认 MainActor 隔离（`SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`）的工程：`nonisolated` 函数里别对自定义枚举用 `==`；static 纯函数作函数值传给 nonisolated 闭包须标 `nonisolated`；视图间传递的闭包类型不标 `@MainActor`；自定义 `PreferenceKey` 声明成 `nonisolated struct`、`defaultValue` 写成计算属性（`static var defaultValue: T { … }`），否则协议一致性报隔离错（某项目）
- **`nonisolated` 不等于离开主线程**：`SWIFT_APPROACHABLE_CONCURRENCY = YES` 会开启 `NonisolatedNonsendingByDefault`，`nonisolated async` 函数改在**调用方**的执行器上跑——从 MainActor 的 `Task { }` 里 `await` 它，Vision 推理、图片解码照样压在主线程。重活入口标 `@concurrent`（或包 `Task.detached`），DEBUG 下在入口加 `dispatchPrecondition(condition: .notOnQueue(.main))` 自检；默认 MainActor 隔离的工程里，没标 `nonisolated` 的类型（如图片缓存工具 enum）整个是 MainActor，它的 static 方法连读盘都在主线程。某项目、某项目 与 某项目 同此配置（某项目 未开）——「标了 nonisolated 就在后台」的老口诀在这类工程里不成立（某项目 2026-10-13）
- 经 `xcrun mcpbridge` 调 `RenderPreview` 出验收图：结果不带图片内容，图在返回 JSON 的 `previewSnapshotPath`（本机临时文件，拷出来用）；默认套设备外框渲染，内容比屏幕高就被裁、右上角还有摄像头黑点，组件类预览写 `#Preview("名", traits: .sizeThatFitsLayout)` 按内容大小出图；动画用 TimelineView 驱动时出图那一刻不确定，要定格就让表演的开演时刻在未来、静止渲染（某项目 2026-10-22 水獭验收）
- **最低版本已够、还留着的 `if #available` 后备分支会埋闪退**：最低版本 iOS 18 的工程里写 `if #available(iOS 18.0, *) { … } else { ZStack { 多个子视图 } }`，后备分支按「iOS 26 的 API 全可用」来编，ViewBuilder 选中只在 iOS 26 才有的 `TupleContent`。编译器报两条告警：「conformance of 'TupleContent…' to 'View' is only available in iOS 26.0」和「'ViewBuilder' does not implement 'buildLimitedAvailability'; this code may crash on earlier versions of the OS」。Swift 6 模式下这是错误；Swift 5 模式下编得过，但 iOS 18–25 的机器上可能闪退。最低版本 iOS 17 时没有这个问题。改法有两种：最低版本已够就删掉这个判断；组件库还要兼容更低版本，就把后备分支整个抽成独立的 View 结构体，两个最低版本下都不再告警。组件库要兼容几个最低版本，就在每个最低版本下各类型检查一遍（ShipSwift Pro 2026-10-26，最小复现已验证；Pro 随后定为只支持 iOS 18，iOS 17 后备全删）
- 同一个算式，换个最低版本就可能「unable to type-check this expression in reasonable time」：可用的重载随最低版本变。CGFloat 与 Double 混算后再套 `min(max(…))` 最容易中招，比如 `min(max(1 - (vx * vx + vy * vy) * 0.9, 0), 1)` 在 iOS 17 编得过、iOS 18 超时。拆成几个中间变量就好（ShipSwift Pro 2026-10-26）
- 在主线程上 `AVAudioPlayer.play()`，每放一次都报 `AVAudioSession_iOS.mm:978 This method can lead to UI unresponsiveness if called on the main thread`：播放器开播时会再激活一遍音频会话，提前在后台 `setActive(true)` 也压不住（异步激活的接口 iOS 27 才有）。把播放器整个收进一个 `actor`（读文件、`play`、`updateMeters`、`stop` 都在里面），主线程只 `await` 它（某项目 2026-10-15，模拟器日志：改前每句一条，改后零条、照常出声）

## 布局

- 真机主线程栈只有 1 MB（模拟器 8 MB）：同一结构体里 `some View` 计算属性层层嵌套，首次渲染展开类型时栈溢出（`EXC_BAD_ACCESS code=2`，栈顶 `SubstGenericParametersFromMetadata`），模拟器测不出——超大页在分段处套 `AnyView` 或拆成独立 struct（某项目 创建页曾因此真机点开即崩）。模拟器复现：编译时加 `ENABLE_DEBUG_DYLIB=NO OTHER_LDFLAGS='$(inherited) -Wl,-stack_size,0x80000'` 把主线程栈压到 512 KB
- 真机屏比模拟器窄，某行撑宽会让整页可横向拖动；一级页内容统一 `containerRelativeFrame(.horizontal)`（嵌进 overlay 时改 `maxWidth: .infinity`，否则铺成窗口宽）
- `scaledToFill` 图：定高直接 `.frame` 会把布局撑宽；溢出部分仍吃点击（`clipShape` 不裁 hit-test）——装饰层收背景 ZStack 并 `allowsHitTesting(false)`，卡级给 `contentShape`
- `TabView(.page)` 不可加 `safeAreaPadding`（真机页面错位），留白写页内 `.padding(.horizontal)`；全宽轮播用横向 ScrollView + `containerRelativeFrame` + `.viewAligned`；TabView 会预建相邻页——入场动效用 `onAppear`，要等翻到才播的用 `.task(id: isActive)`
- 横向 ScrollView 里的 `LazyHStack` 纵向会吃满提议高度（`HStack` 不会）；它的实测高若回推别的布局（如底部抽屉的停靠位），外层须 `.fixedSize(horizontal: false, vertical: true)` 定高——ZStack 摆放时会把自身尺寸再提议给子视图，不定死就成「实测高 → 停靠位 → ZStack 高 → 实测高」的死循环（某项目 首页曾因此卡死，控制台报 `onChange(of: CGFloat) action tried to update multiple times per frame`）
- `overlay` 里直接放 `if let` 条件内容时，会先按全宽量出子视图的理想宽度，再把这个带小数的宽度原样提议回去重排；HStack 里含小数尺寸的兄弟（如 `frame(minWidth: 9.5 * 1.7)` 的按键帽）分配时损掉一丝，单词放不下就被拆成「U…」两行（某项目 删除提示的 Undo 曾因此显示成两行）——这类胶囊提示条内容加 `.fixedSize()`；外面包一层 `VStack` 也能避开
- 铺满全屏的 `GeometryReader`（自己挂了 `.ignoresSafeArea()`）读到的 `safeAreaInsets` 是 0：要按安全区摆东西（如和左上角按钮对齐），外面再包一层不铺满的 `GeometryReader` 读 `safeAreaInsets`，里面那层仍铺满全屏画；两层的原点都在屏幕左上角（某项目 2026-10-16，模拟器截图：逗点按 0 算，贴到了灵动岛旁边）。要和导航栏按钮对齐，干脆用原生导航栏：元素直接放进 `ToolbarItem`；要飞进画面的，内容层另画一只，起飞时把导航栏里那只藏起、内容层那只从它的位置（`onGeometryChange` 量 `.global`）飞出去。量内容层自己的原点要在铺满的 `GeometryReader` 里取 `geo.frame(in: .global)`：`onGeometryChange` 挂在 `.ignoresSafeArea()` 后面量到的是铺开前、安全区内的框（某项目 2026-10-16 实测 iPhone 18 Pro Max 量到 y=116，把导航栏里的位置判成了画面外）
- `frame(in: .scrollView)` 的原点在滚动视图顶部内边距之下（导航栏、`safeAreaBar` / `safeAreaInset` 都算在内）：判断「滚到吸顶条下沿」直接比 0，别再加 `contentInsets.top`（某项目 首页段标题曾因此提前一整截内边距就换）
- 全屏背景图别只写 `.resizable().scaledToFit().ignoresSafeArea()`：竖屏手机宽小于高，看着是按宽铺满；iPhone Duo 展开屏宽大于高（951×669pt），方图就改按屏高缩放、居中，两侧各空一截。要始终按屏宽铺满、贴顶，写成 `Color.clear.overlay(alignment: .top) { Image(…).resizable().scaledToFit().fixedSize(horizontal: false, vertical: true) }.clipped().ignoresSafeArea()`，宽屏上超出屏底的部分裁掉，竖屏手机上尺寸位置不变（某项目 2026-10-29，Duo 模拟器截图核对）

- 滚动容器一屏放几页时（`containerRelativeFrame(.horizontal, count: 2, span: 1, spacing: 0)`），`.scrollPosition(id:)` 要写 `anchor: .leading`：不写锚点时系统只滚到「看得见」为止，下一页已经露着就不动，自动翻页看着卡住（某项目 2026-11-04，iPhone Duo 模拟器录屏）
- iPhone Duo 展开（951×669pt，横宽）：原生 `TabView` 和导航栏按钮自动挪到右侧状态栏那一列，自绘的浮层 tab bar 没有这个待遇；右边那列是安全区，`containerRelativeFrame` 的页宽不含它，但横向滚动的内容默认画进安全区，邻页会从那列底下露出来，滚动视图上加 `.clipped()`；按屏宽算的 1:1 头图比一屏还高，要给宽屏定高（某项目 2026-11-04）

## 状态与数据流

- `.sheet(item:)` 内容闭包别读其他 `@State`（可能是旧值），需要的数据全打包进 item
- `@Observable` 的 Environment 非可选形式在 preview 未注入时会崩，一律可选取用；`@Observable` 类的默认实参不能构造 MainActor 隔离对象
- `@Observable` 属性被赋 `==` 相等的新值时只存不通知（Swift 6.2 起）：存进 store 的模型 Equatable 一律按全字段比较，不可自定义成只比 id——否则内容变了、开着的页面不刷新（某项目 Pod 页曾因此踩坑）
- 真数据是异步到的：视图别用 `@State(initialValue:)` 在 init 里抓一次 store 数据当本地队列（mock 同步就绪看不出来），要随 store 派生、本地只记「已处理」（某项目 待办区曾因此恒空）
- 计算属性里现造的展示模型别用 `let id = UUID()` 当 `ForEach` 的 id：每次取都换新，父视图一重算（如每秒一拍的倒计时）子视图就被整个拆掉重建，`@State` 清零、`AsyncImage` 退回占位再重载，看着像闪；id 取稳定的业务键（人名、记录 id）。网络图也别用 `AsyncImage`：它没有内存缓存，视图一重建就先露占位。改用首帧同步查内存缓存的组件：新项目直接取 ShipSwift 的 `SWCachedImage`（skill `component-cached-image`，iOS / macOS 通用），旧项目各有一份（某项目 `CachedImage`、某项目 `SPRemoteImage`、某项目 `ImageLoader`）（某项目 2026-10-18，模拟器录屏逐帧：改前猜数尺头像每秒闪一帧字母盘，改后 7 秒画面不变）
- SwiftData 的 `@ModelActor` 默认执行器（DefaultSerialModelExecutor）在调用方线程上同步执行：一个 ModelActor 调另一个会嵌套在同一线程、把前一个一直占住，并占着 Swift 并发的线程池。要几个数据 actor 各自独立，就自写 `SerialModelExecutor`、把 `enqueue` / `asUnownedSerialExecutor` 交给一条 `DispatchSerialQueue`（ModelContext 照样在主线程之外创建）。Core Data 取库连接用信号量、不提升低优先级的占用者：同一个库的后台活别降到 utility（与界面调用统一 userInitiated），否则 Xcode 报 Hang Risk「User-initiated 线程在等 Utility 线程」（某项目 2026-10-11 实测：后台 utility 每次启动 1–2 条，统一后零条；调用栈停在 `-[NSSQLDefaultConnectionManager _checkoutConnectionOfType:]`）
- 离线队列的错误要分流：断网 / 超时 / 5xx / 429 是偶发，op 放回队首、退避后重推；只有 4xx 才算永久错误（丢弃该 op、提示用户、立即全量对齐），额度类 403 也不许删用户已拍的内容——「遇错一律丢 op」等于把服务器一次抖动变成数据丢失（某项目 2026-10-13）。API 别用 `URLSession.shared`：它会把 GET 响应写进共享 URLCache（某项目 6b8c8e6 修过），用独立 session、`urlCache = nil` + `requestCachePolicy = .reloadIgnoringLocalCacheData`
- 用 `keyWindow?.rootViewController?.presentedViewController != nil` 判断「屏幕被 sheet、alert 盖着」：sheet 收起动画期间它还不是 nil。sheet 里的按钮先关 sheet 再跳页（如建圈成功页点 View Pod），新页出现那一刻仍判「盖着」，据此直接放弃的一次性演出（初次见面）就丢了；要轮询等它变 nil 再停稳，或在 sheet 的 `onDismiss` 里再触发（某项目 2026-10-22 水獭，模拟器连拍：改前 8 张都没挥手，改成等收起后第 2 到 5 张在挥手）

## 渲染与数据格式

- `Canvas` / `Shape` 描边沿路径居中画，有一半线宽落在路径外：圆按画布一半为半径画再描边，外圈会被画布边缘切掉一圈。路径往里收半个线宽（`r - lineWidth / 2`），或用 `strokeBorder`（某项目 2026-10-15）
- 列表卡片上别用渐变描边或渐变填充 `Shape`（`.strokeBorder(LinearGradient(…))`）：这类形状走 `PaintShapeLayer`，主线程 CoreGraphics 软件绘制，代价按外框面积算，1pt 细线也要画满整张卡（Time Profiler 自耗在 `argb32_shade_axial_RGB`，上一级是 `CGDisplayListDrawInContextDelegate`），滚动时同一批图层每帧重绘，body 并不重算，`_logChanges` 看不出来。iPhone 18 Pro Max 模拟器上一圈约 5 ms，一屏 5 张卡两圈就超过一帧。改成 `LinearGradient(…).mask { Shape().strokeBorder(lineWidth:) }`，外观一样、不再走 CG；纯色描边同样没有这个问题（某项目 2026-11-04 首页 `GlassRim`，模拟器自动滚动实测：改前约 20 帧/秒、10 秒掉帧约 180 次，改后约 59 帧/秒、8 到 14 次；真机未测，遮罩的 GPU 代价未量）。查法：Time Profiler 只看主线程自耗；要定位是哪个图层，临时 swizzle `-[CALayer _display]` 按类名与尺寸记耗时；量帧率用 `CADisplayLink` 自动改 `contentOffset`，别用 MCP 合成滑动（它每步抓无障碍树，本身就占主线程）
- 循环的 `.phaseAnimator`（呼吸点、光晕）挂在叶子视图上，整页又靠祖先的 `.offset` 移动（如自绘 tab 横滑切页）时，叶子的位置会被算进这段循环动画：小点落在后面、慢慢横穿卡片，约 1 秒才回原位。在 `.phaseAnimator` 外面加一层 `.geometryGroup()` 隔开父视图的位移（某项目 2026-11-05 Live 胶囊的呼吸点，`simctl io recordVideo` 录屏逐帧对比：改前小点离开胶囊约 1 秒，改后不离开；ScrollView 滚动不走这条路，没这个问题）
- 按钮上的装饰层（如可用那一刻扫过的一道光）别用 `.offset` 把子视图挪到按钮外面候场：画面上 `clipShape` 裁掉了，无障碍框却按挪出去的位置并进按钮，VoiceOver 焦点框跟着变宽；给装饰层加 `.accessibilityHidden(true)` 也去不掉。改为在按钮框内用 `Canvas` 按进度画（`TimelineView` 驱动，扫完把起始时刻置空、卸掉这层），子视图不挪位（Contact 2026-10-24，Xcode MCP 层级树实测：改前按钮框宽 568–784、起点在屏幕外，改后 392）
- 换图做交叉淡入淡出（`if let` + `.id(x)` + `.transition(.opacity)`，容器挂 `.animation(_:value:)`）：状态若是在别处的 `withAnimation(短动画)` 里改的，被撤的旧图跟着那个短动画先没了，新图还在慢慢淡入，中间露出底色、像闪了一下。把动画挂在过渡上：`.transition(.opacity.animation(.easeInOut(duration: 0.6)))`（某项目 2026-10-15，录屏逐帧量出：旧图 0.2 秒撤完、新图 0.6 秒才淡入）
- 着色器参数要随动画变（如过渡进度）：写一个 `Animatable` 的 `ViewModifier`，`animatableData` 就是进度，`body` 里 `colorEffect(ShaderLibrary.xxx(.boundingRect, …, .float(progress)), isEnabled: progress < 1)`，`withAnimation` 改进度即逐帧插值；默认 MainActor 隔离的工程里照样编过。放射状揭开要显得慢：用匀速（缓入缓出会把面积变化挤在中间半秒），距离按露出来的区域归一（被面板挡住的部分不占时长）（某项目 2026-10-15 欢迎引导换页）
- `ImageRenderer` 出带透明的 PNG（投影、光晕）别用 `uiImage.pngData()`：它把预乘过的颜色原样写成直通 alpha，半透明像素发暗（浅蓝投影变灰黑），而且是 16 位。取 `renderer.cgImage` 画进 8 位 `CGContext`（色彩空间按需，`premultipliedLast`）再经 ImageIO `CGImageDestination` 写 PNG，颜色与透明度都对（某项目 2026-10-13 重渲启动图实测）
- `Decimal(string:)` 不认千分位、不拒杂字符：用户输入先校验，回写输入框用 `"\(decimal)"`
- 逗号作小数点的地区（德、法、土耳其等）：`Double("19,99")` 是 nil。用 `.formatted(.number)` 回显、再用 `Double()` 解析，数值会在用户改别的字段时被悄悄清空——解析统一用 `Double(text, format: .number)`（当前 locale），回显与解析同一套 locale（某项目 2026-10-13，编辑表单的买价）
- 纯日期串（`"yyyy-MM-dd"`，DB 的 date 列）按**当前时区的正午**解析、按当前时区格式化：按 UTC 午夜解析再按本地显示，美国用户看到的是前一天（导出的报告同错），开发机在 UTC+8 永远测不出；正午留出 ±12 小时余量，用户跨时区也不跳日（某项目 2026-10-13）
- Charts：滚动窗口用绝对序号 / 时间做 X 与 id；`AreaMark` 必须带 `yStart` 锚定，否则冲出 domain
- 流动虚线（`StrokeStyle.dashPhase` 随时间走）的相位一定先对虚线周期取余：CoreGraphics 从相位起逐段走虚线图案，耗时与相位成正比，直接用 `timeIntervalSinceReferenceDate × 速度`（约 1e10）画一次近 1 秒，配 `TimelineView(.animation)` 每帧重画，整台电脑都被拖住（某项目 首启引导 2026-10-11 实测：相位 1e8 → 13 ms，1.3e10 → 0.9 s）
- 会随 sheet 档位缩放的自定义 `Shape`：系统缩放时把新旧两条路径逐点插值，路径的元素个数随尺寸变（如按高度排的打孔、锯齿）就扭成台阶与波浪；外形路径保持结构不变，数量随尺寸变的细节拆成独立视图（按稳定 id 的 ForEach，孔用遮罩 `destinationOut` 挖）（某项目 创建票 2026-10-08；排查法：临时启动参数让 sheet 自动来回切档，`simctl io recordVideo` 录屏后 ffmpeg 拆帧看）
- `.buttonStyle(.glassProminent)` 配浅色 tint（白、亮绿、亮黄）时标签默认是白字，看不清；在按钮上加 `.foregroundStyle(深色)` 就能改标签色（Contact 2026-10-23 模拟器实测）。按亮度自动取字色：`Color.resolve(in: EnvironmentValues())` 取 `linearRed/Green/Blue` 算相对亮度，大于 0.179 用深色字
- 根视图外面包一层带圆角的 `.clipShape`（比如推开式抽屉把主界面缩成卡片）时，裁切框是视图自己的布局框，只到安全区：状态栏下的背景、标签栏下半截都会被裁掉。要裁到整屏，用自定义 `Shape` 在 `path(in:)` 里按 `GeometryReader` 读到的 `safeAreaInsets` 往外扩（Contact 2026-10-23 实测）
- iOS 26 起原生 tab bar 里没选中的 SF Symbol 一律画成黑色，而且系统默认把四个图标都填成实心。改不了颜色：`UITabBar.appearance().unselectedItemTintColor` 和 `UITabBarAppearance` 的 `normal.iconColor` 在 iOS 27 的玻璃 tab bar 上都不生效，标签里的 SwiftUI `.saturation` / `.opacity` 修饰也被丢掉。能做的有两条：标签里 `Image(systemName: 选中 ? "x.fill" : "x")` 再挂 `.environment(\.symbolVariants, .none)`，得到选中实心、没选中线框（仍是黑色）；或者换成按原图渲染（`template-rendering-intent: original`）的彩色图，原生 tab bar 会保留原色，没选中的灰色版要预先另做一张图（某项目 2026-10-31，iOS 27.2 模拟器逐项实测）。选中项的文字色也不认资源里设的全局强调色（`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`），不设就是系统蓝：在 `TabView` 上挂 `.tint(主色)`，或在 App 根挂 `.accentColor(...)`（某项目 2026-10-31 实测）
- App 冷启动时做定时演出（启动页），别一段段 `Task.sleep(for:)` 地等：冷启动主线程忙，每段都拖后，误差累加。用 `ContinuousClock` 记下起点，每段 `clock.sleep(until: start + .seconds(x))`（某项目 2026-11-04 实测：改前 0.95 秒的编排拖到 1.3 秒，改后 1.03 秒）

## 手势与输入

- 容器挂 `.contentShape(.rect).onTapGesture`（整卡点击）：子级 Button、子级 `onTapGesture` 优先，点它们父级不触发；点 UIKit 承载的文本框本体（`TextField`，含 `axis: .vertical`）父级也不触发，但点输入面上的 SwiftUI 留白、图标会触发——输入面整块再挂 `.onTapGesture { focused = true }` 挡住（某项目 2026-10-13 实测，iOS 27 模拟器）
- 父级的点按手势会抢 UIKit 承载的按钮：面板整块挂点按（点空白处接下一句），里面的 `SignInWithAppleButton` 在真机上短按没反应、长按才管用（按久了父级的点按作废，按钮才收到抬手）。露出这类控件时停用父级手势：`.gesture(TapGesture().onEnded { … }, isEnabled: !showsInput)`（某项目 2026-10-15 真机实测）
- iOS 26 的 sheet 半屏档位默认铺 Liquid Glass，`.presentationBackground(.clear)` 去不掉这层玻璃（全屏档才换成不透明底）。要 sheet 完全不铺底：iOS 26.1 起 UIKit 有 `UISheetPresentationController.Detent.backgroundEffect`，从 sheet 内容里放一个 `UIViewRepresentable` 探针，顺响应链找到 `UIViewController.sheetPresentationController`，给每个档位设 `UIVisualEffect()`（空效果），再配 `.presentationBackground(Color.clear)`（iOS 18 只靠后者即可）（某项目 创建页 2026-10-14 实测：iOS 27 模拟器上玻璃消失，半屏与全屏都只剩内容）
- 想让内容顶进导航栏那一行：负的上 padding（或 `ignoresSafeArea`）只改画在哪，导航栏照样盖在上面，透明也会吃掉它盖住的点按，顶进去那截点不动；停在页顶时 iOS 26 的滚动边缘效果还会糊住它（页顶时 `scrollEdgeEffectHidden(true, for: .top)`，用 `onScrollGeometryChange` 判断滚开后复原）。只顶一点、点不动的那截够小，就用负 padding；要与右上角按钮整行并排，改为该页 `.toolbar(.hidden, for: .navigationBar)`、按钮放进内容（iOS 26 起包 `glassEffect(.regular.interactive(), in: .capsule)` 与系统导航栏胶囊一致），代价是按钮随页面滚走（某项目 YOU 页 2026-10-13、10-14 实测：iPhone 18 Pro 导航栏下沿在 116pt，以下才点得动；开发者最后选了负 padding 顶 28pt，头像顶上约 22pt 点不动）
- 列表里的输入框（尤其 `TextField(axis: .vertical)` 会随换行长高）别指望 ScrollView 自己让到键盘上方：自定义抽屉里的列表聚焦时根本不滚，换行长高、上方插进新内容时也不跟；`ScrollViewReader.scrollTo(id, anchor: .bottom)` 同样不可靠（列表拿到的键盘内边距只有 202，键盘实际 347，滚完仍压在键盘后面）。可靠做法：`onGeometryChange` 记下输入区在 `.global` 里的下沿（存进不受观察的类，滚动时每帧都在变，不触发重绘），`keyboardDidChangeFrameNotification` 记键盘上沿（终帧高度为 0 当没有键盘），聚焦、长高、内容变动时下一拍比一比，挡住多少就把外层列表底层的 UIScrollView（输入区挂一个空 UIView 往上找）`setContentOffset` 加多少，没挡不动（某项目 大卡背面留言框 2026-10-27，iOS 27 模拟器实测：改前键盘升起后留言框整个在键盘后面，改后留言框连同卡底 22pt 留白停在键盘上方）
- 判断「正在打字」别靠键盘升降通知：接了外接键盘就不弹软键盘、也不发 `keyboardWillShow`（模拟器常开着 Connect Hardware Keyboard）。用 `UITextField` / `UITextView` 的 `textDidBeginEditingNotification` / `textDidEndEditingNotification`（四条各挂一个 `.onReceive`）；没有 FocusState 可收时，`UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)` 统一收起。开着 `MemberImportVisibility` 的工程，Combine 的 `merge(with:)` 等运算符要显式 `import Combine`，单用 `NotificationCenter.publisher(for:)` + `.onReceive` 不用（某项目）

- 推送的 `UNUserNotificationCenterDelegate` 别用 async 写法（`didReceive response:) async`）：系统的完成回调由 Swift 在后台线程调，点开通知时 UIKit 做主线程断言，App 当场崩（`_performBlockAfterCATransactionCommitSynchronizes:`，SIGABRT，崩溃线程的调用链里有 `@objc closure #1 in …userNotificationCenter(_:didReceive:)`）。`await MainActor.run` 之后函数还是回到后台，救不了。一律用 `withCompletionHandler` 写法，回主线程处理完再调回调（某项目 2026-11-02 TestFlight 崩溃日志定谳）

## 模拟器

- 截图坐标换算：px→pt 除数 = 截图像素宽 ÷ 设备逻辑宽（Pro Max 440pt、Pro 402pt），不是固定 ÷2；点按一律以层级树的 hitPoint 为准
- 推送：Apple 芯片模拟器拿得到真 APNs sandbox 令牌，服务端推送能真到达；测点开路由用 `xcrun simctl push <UDID> <bundleID> <payload.json>`；Xcode MCP 点横幅时别带 `activationBundleId`（先激活 App 会把横幅收掉）
- 改了启动页（LaunchScreen.storyboard 或其中的图）重跑还是旧的：模拟器的 `splashboardd` 把旧图缓存在内存里，删快照也会照旧图重画。删掉 App 数据目录（`xcrun simctl get_app_container booted <bundleID> data`）里的 `Library/SplashBoard`，再 `kill -9` 这台模拟器的 `splashboardd`（`ps -o ppid=` 找父进程 launchd_sim 认设备；普通 kill 杀不掉），重跑即新；不用删 App（2026-10-17 某项目 实测）
- 模拟器起不来、`simctl list` 里卡在 `Shutting Down`：常见前兆是 `simctl io screenshot` / `recordVideo` 一直不返回（设备连续开机好几天后内部卡死）。此时 Device Hub 里的关机、重启、删除都会挂起不执行，`CoreSimulator.log` 反复报 `Code=405 "Unable to lookup in current state: Shutting Down"`。解法：`kill` 这台设备的 `launchd_sim`（`ps` 找参数里带该 UDID 的那个），再 `killall -9 com.apple.CoreSimulator.CoreSimulatorService`（系统会自动拉起，不丢设备数据）。注意：之前挂起的删除请求会在服务重启后**立刻执行**——处理前先用 `log show` 查有没有 `RemoveProvisionedDevice`，免得把要留的设备一并删掉（ShipSwift 2026-10-25 实测：默认机因此被删，重建后 UDID 变了）
- 删旧模拟器运行时后，磁盘空间没回来：卸载 cryptex 一报错，系统只注销运行时，不回收文件。7–8 GB 的镜像留在 `/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/<hash>.asset`，这个目录受 SIP 保护，`sudo rm` 也删不掉；`simctl runtime list` 里看不到它，各 asset 的 `Info.plist` 里 `SimulatorVersion` 写着版本。回收办法：`xcodebuild -downloadPlatform iOS -buildVersion <旧版本> -architectureVariant arm64`，它认出本地已有的文件，不重新下载就重新登记；再 `xcrun simctl runtime delete <新 ID>`，日志里出现 `MAPurgeSucceeded` 才算回收。Apple 报错里建议的 `simctl runtime scan-and-mount` 认不出来，反倒多登记一条 Unusable 记录指向同一份文件，这条也得 delete，否则不回收。顺手可清：Xcode 预览专用模拟器里的旧机 `xcrun simctl --set previews delete unavailable`（这次 5.7 GB），旧 Metal 工具链 `xcodebuild -deleteComponent metaltoolchain -buildVersion <旧版>`。删运行时之后，系统会给新运行时自动建一套默认机，Xcode 还会把旧机搬到新运行时上重建，同名机型因此各有两台（2026-10-31 升级 27.2 实测，回收 27.0 镜像 7.5 GB）

## macOS（菜单栏 App / 非激活面板）

- 非激活 `NSPanel`（`.nonactivatingPanel`）里放 SwiftUI `TextField`：窗口一成为 key，AppKit 就把第一个文本框设为焦点，回车、方向键全被它吃掉——焦点要停在别处时，`makeKeyAndOrderFront` 后立刻 `makeFirstResponder(nil)`，下一轮 runloop 再补一次（某项目）
- 面板不激活 App，按键走不到主菜单：⌘A / ⌘C / ⌘V / ⌘X 要在本地 keyDown 监听里转给字段编辑器（`window.firstResponder as? NSTextView`）。"直接打字即搜索"别自己往绑定里拼字符：会绕开拼音等输入法，首字母直接上屏、其余字母进候选。正确做法是把按键攒着，等搜索框拿到焦点后用 `NSApp.sendEvent` 原样重放；`hasMarkedText()` 为真（输入法正在组字）时按键一律放行，回车上屏、Esc 取消都交给输入法（某项目）
- 用 System Events 发键做自动化核对：数字按小键盘码发（keyCode 82–92，带 `.numericPad`），字母会进当前输入法（拼音下进组字）；核对会写系统剪贴板，先用 `osascript -e 'clipboard info'` 看类型（不读内容），纯文本就 `pbpaste` 暂存、测完 `pbcopy` 还原（某项目）
- macOS App 的 SwiftUI 预览（Xcode 画布）会把整个 App 进程拉起来、照常跑 `applicationDidFinishLaunching`：菜单栏 App 等于在后台多开一份——同开数据库与 CloudKit 同步库、同时采集、抢全局快捷键，`ps` 里是父进程为 1 的同名进程（环境变量带 `XCODE_RUNNING_FOR_PREVIEWS=1`）。Debug 下装配前判断这个环境变量，是预览就直接返回（预览只渲染视图，环境对象用 `.previewFallback`）（某项目 2026-10-11 实测：预览进程开着全部三个库）
- 无边框透明窗口（`isOpaque = false`、`hasShadow = true`）里放 SwiftUI 圆角玻璃：窗口从零尺寸放大（`contentRect: .zero` 先装内容再 `setFrame`）或显示中改尺寸后，圆角外的四角不再全透明，系统按整个矩形画阴影，圆角外露出一圈直角黑边；`invalidateShadow()` 无效，SwiftUI 的 `.clipShape` 也挡不住。解法：宿主 `NSHostingView` 的图层按同一圆角裁切（`cornerRadius` + `cornerCurve = .continuous` + `masksToBounds = true`），之后怎么改尺寸都是圆角阴影（某项目）

- `.scrollPosition(id:)` 绑定的那一项从数据里删掉后，ScrollView 不回写绑定：位置已经落在相邻项上，绑定还是旧 id，用它算的「第 n 张」会错（`firstIndex` 取不到退回第 1 张）。在 `.onChange(of: ids)` 里发现旧 id 不在了，就按原下标改指相邻项（2026-11-03 某项目 首页 Needs You 轮播）
- 带圆头（`lineCap: .round`）的 `trim` 进度环：圆头在两端各多出半个线宽，看到的弧比 trim 的范围长，且起点会探过 12 点。要让外缘正好是进度，两头都要收 `lineWidth / 2 / (2π r)`：`.trim(from: cap, to: max(cap + 0.001, value - cap))`；满圈单独画不带圆头的整圈，否则两头碰头有缝（2026-11-03 某项目 胜率环）

- 内嵌中文字体缺字（如得意黑缺「記」「館」）时默认回退到苹方 Regular，粗标题里会一下变细。用 `UIFontDescriptor(name:size:).addingAttributes([.cascadeList: [UIFontDescriptor(name: "PingFangSC-Semibold", size: size)]])` 指定回退字，再经 `Font(UIFontMetrics(forTextStyle:).scaledFont(for: UIFont(descriptor:size:)))` 给 SwiftUI，回退字重在 SwiftUI 里生效；一串文字里只给数字换字体用 `AttributedString` 按范围设 `.font`（某项目 2026-11-04，iOS 27.2 模拟器）
