在 Sprout（习惯打卡 App）里加「编辑习惯」：

- 在习惯列表点一条习惯，弹出编辑页（sheet），可以改名字和颜色（颜色从 `Habit.palette` 里选）。
- 编辑页有 Save 按钮，调 `HabitStore.shared.save(_:)` 保存。
- 保存成功：关掉编辑页，屏幕顶部提示「Saved」。
- 保存失败（比如名字为空）：编辑页不关，屏幕顶部提示错误信息（用错误的 `localizedDescription`）。

照仓库里的项目约定做。
