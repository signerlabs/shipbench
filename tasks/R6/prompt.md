在 Sprout（习惯打卡 App）里加「设置」页：

- 入口：习惯列表右上角加一个齿轮按钮，点了打开设置页。
- 设置页有：语言（English / 简体中文）、分享 App、服务条款、隐私政策、版本号、退出登录、删除账号，别的不要。
- 网址：App Store 链接 `https://apps.apple.com/app/id6741234567`，服务条款 `https://sprout.example.com/terms`，隐私政策 `https://sprout.example.com/privacy`。
- 退出登录调 `AuthStore.shared.signOut()`。删除账号要真的删掉服务器上的账号，调 `AuthStore.shared.deleteAccount()`；失败时提示错误。
- 退出登录或删除账号之后回到登录页（`SignInView`）。

照仓库里的项目约定做。
