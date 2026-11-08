import XCTest

// AgentEval 操作重放：读 PLAYER_SCRIPT 指向的 JSON 脚本，启动指定 App，按步骤点按、拖动、等待、截图。
// 坐标一律是相对 App 窗口的比例（0–1），这样和机型分辨率无关。
struct Step: Decodable {
    var op: String               // wait | tap | drag | shot | allow
    var t: Double?               // wait 的秒数
    var x: Double?; var y: Double?
    var x2: Double?; var y2: Double?
    var hold: Double?            // drag 按下后停多久再拖
    var v: Double?               // drag 速度（点/秒）
    var after: Double?           // drag 到终点后停多久
    var path: String?            // shot 的保存路径
    var label: String?           // allow：系统弹窗里要点的按钮文字
}
struct Script: Decodable {
    var bundleId: String
    var launchArgs: [String]?
    var steps: [Step]
}

final class PlayerUITests: XCTestCase {
    func testPlay() throws {
        continueAfterFailure = true
        guard let path = ProcessInfo.processInfo.environment["PLAYER_SCRIPT"] else { return XCTFail("没有 PLAYER_SCRIPT") }
        let script = try JSONDecoder().decode(Script.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let app = XCUIApplication(bundleIdentifier: script.bundleId)
        app.launchArguments = script.launchArgs ?? []
        // PLAYER_MARK：记下启动和结束的时刻（Unix 秒），录屏后据此剪掉测试工具自己启动的那段
        let mark = ProcessInfo.processInfo.environment["PLAYER_MARK"]
        func stamp(_ tag: String) {
            guard let mark else { return }
            let line = "\(tag) \(Date().timeIntervalSince1970)\n"
            if let h = FileHandle(forWritingAtPath: mark) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
            else { try? line.write(toFile: mark, atomically: true, encoding: .utf8) }
        }
        stamp("launch")
        app.launch()
        defer { stamp("end") }
        func at(_ x: Double, _ y: Double) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        for s in script.steps {
            switch s.op {
            case "wait":
                Thread.sleep(forTimeInterval: s.t ?? 1)
            case "tap":
                at(s.x ?? 0.5, s.y ?? 0.5).tap()
            case "drag":
                at(s.x ?? 0.5, s.y ?? 0.7).press(forDuration: s.hold ?? 0.05,
                                                  thenDragTo: at(s.x2 ?? 0.5, s.y2 ?? 0.3),
                                                  withVelocity: XCUIGestureVelocity(CGFloat(s.v ?? 1200)),
                                                  thenHoldForDuration: s.after ?? 0)
            case "shot":
                if let p = s.path {
                    stamp("shot:" + URL(fileURLWithPath: p).deletingPathExtension().lastPathComponent)
                    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: p))
                }
            case "allow":
                let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                let button = springboard.buttons[s.label ?? "Allow"]
                if button.waitForExistence(timeout: 3) { button.tap() }
            default:
                break
            }
        }
    }
}
