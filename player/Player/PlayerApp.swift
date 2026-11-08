import SwiftUI

// 只是 UI 测试需要的宿主 App，本身什么都不做；真正被操作的是脚本里指定的那个 App
@main
struct PlayerApp: App {
    var body: some Scene { WindowGroup { Text("AgentEval Player") } }
}
