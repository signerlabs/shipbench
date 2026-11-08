这是一个宠物健康档案 iOS App（SwiftUI，无第三方依赖）：记宠物资料、疫苗、驱虫和看诊。数据存在后端，走 REST 接口：新建用 POST，编辑用 PATCH；后端的 PATCH 只改请求体里出现的字段，字段值是 null 就把那一列清空。工程是 `PetBook.xcodeproj`，单元测试在 `PetBookTests/`（Swift Testing）。

用户反馈：编辑疫苗记录，把下次到期日、品牌或备注清空后保存，刷新一下，旧值又回来了。

要求：

1. 编辑时清空的字段要在服务器上真的清空。疫苗、驱虫、看诊记录，还有宠物资料（品种、生日、芯片号、牌照号、牌照到期日、领养日）都一样。
2. 新建时没填的字段不要发，交给后端的默认值，不能发 null。
3. 宠物性别这一列后端不收 null，任何时候都不能发 null；把性别改回「未知」也要能存上。
4. 宠物照片走单独的上传接口，编辑资料时不能把照片清掉。
5. 补上测试。全部测试都要通过：`xcodebuild test -project PetBook.xcodeproj -scheme PetBook -destination 'platform=iOS Simulator,name=iPhone 18 Pro Max'`
6. 不删已有的测试，不改现有类型和函数的用法（别处和测试都在用）。
