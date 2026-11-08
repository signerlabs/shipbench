给 Sprout（习惯打卡 App）加首次启动的欢迎页：

- 第一次打开 App 时先显示三页欢迎页，可以左右翻页，也可以跳过；最后一页点按钮进入 App。以后再打开直接进 App，不再显示欢迎页。三页的内容：
  1. 图标 `leaf.fill`，标题「Build tiny habits」，说明「Check in once a day and watch your streak grow.」
  2. 图标 `bell.fill`，标题「Never miss a day」，说明「Gentle reminders at the time you choose.」
  3. 图标 `location.fill`，标题「Habits near you」，说明「Get nudged when you arrive at the gym or the park.」
- 欢迎页显示期间申请通知权限和定位权限（使用期间定位）。用户允不允许都不影响使用。
- 进入 App 后照常加载习惯列表（`HabitListView` 现在的逻辑）。

照仓库里的项目约定做。
