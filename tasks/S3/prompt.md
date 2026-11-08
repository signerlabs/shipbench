这是一个宠物健康档案 iOS App（SwiftUI，无第三方依赖）：记宠物资料、疫苗、驱虫和看诊，到期前推本地通知提醒。工程是 `PetBook.xcodeproj`，单元测试在 `PetBookTests/`（Swift Testing）。

用户反馈：猫同一天打了两针疫苗（比如 FVRCP 和狂犬），下次到期日也是同一天，可到期前只收到一条提醒，另一针的提醒没了。

要求：

1. 修好：每条记录都要有自己的提醒，驱虫、复诊也一样。通知的标识要稳定：数据没变时重新排一遍，标识也不变。
2. 补上能复现这个问题的测试。修好后全部测试都要通过：`xcodebuild test -project PetBook.xcodeproj -scheme PetBook -destination 'platform=iOS Simulator,name=iPhone 18 Pro Max'`
3. 不删已有的测试，不改现有类型和函数的用法（别处和测试都在用）。
