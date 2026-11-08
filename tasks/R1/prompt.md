在 Sprout（习惯打卡 App）里加一个「好友排行榜」页：

- 入口：习惯列表右上角加一个按钮，点了进入排行榜页。
- 数据从接口拉：`GET {APIConfig.baseURL}/v1/leaderboard`，返回 JSON 数组，已经按连续打卡天数从高到低排好，每一项能直接解码成 `LeaderboardEntry`（`userId`、`name`、`avatarURL`、`streakDays`）。
- 每一行显示名次、圆形头像、名字、连续打卡天数；没有头像的显示名字的首字母。
- 进页面时拉一次，下拉可以刷新；拉取失败时在页面上显示错误和「重试」按钮。

照仓库里的项目约定做。
