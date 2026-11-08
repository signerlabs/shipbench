# 原录屏时间轴

Trovy（家庭物品管理 App）的「统计报表」页，以及点进一个房间后的详情页。原录屏总长约 10.5 秒，iPhone 18 Pro Max 竖屏（1320×2868）。`keyframes/` 里的文件名就是对应的时间点。

## 整体样式

- 背景是米白的纸色，内容分成几张白色圆角卡片，卡片之间有间距，卡片标题是小号灰字（By category、Value by room、By room）。
- 顶部导航栏：左边圆形返回按钮，中间标题（报表页是 Home，详情页是房间名），右边圆形分享按钮。
- 数字变化一律是「逐位滚动」的效果（每一位数字上下滚动换成新值），不是直接跳变。

## 逐段说明

- **0.0–1.2 秒：报表页首屏，静止。**
  - 顶部统计卡三列：`236` Items、`5` Rooms、`$30,814` Total value。
  - By category 卡片：左边环形图，中间大字 `236`、小字 `All items`；右边两列彩色圆点图例。
  - Value by room 卡片：五条深棕色横条，房间名在条的左上方，金额在条的右边。
  - By room 卡片：每行左边是房间封面小图，然后是房间名、件数和容器数，右边是金额和箭头。
- **约 1.3 秒：点环形图右侧的绿色扇区（Clothing）。**
  - 被点的扇区保持原色，其余扇区变淡，过渡约 0.3 秒。
  - 环形图中间变成 `38` / `Clothing`。
  - 顶部统计卡逐位滚动成 `38` Items、`5` Rooms、`$5,128`，约 0.5 秒。
- **约 2.6 秒：点右下方的橙色扇区（Home）。**
  - 选中切换到 Home，中间变成 `34` / `Home`。
  - 顶部变成 `34` Items、`4` Rooms、`$1,462`。
  - 同样有淡入淡出和数字滚动。
- **约 4.2 秒：再点一次 Home 扇区，取消选中。**
  - 所有扇区恢复原色，中间回到 `236` / `All items`。
  - 顶部数字滚回 `236`、`5`、`$30,814`。
- **约 5.3 秒：手指上滑，页面往下滚一段**，露出完整的 By room 列表。
- **约 6.8 秒：点 Bedroom 这一行**，标准导航推进到 Bedroom 详情页（从右边滑入）。
- **7.0–8.0 秒：详情页入场动画。**
  - 顶部统计卡变成 `126` Items、`1` Containers、`$16,775` Total value，数字从 0 逐位滚动上来。
  - 环形图从顶部开始顺时针一段一段扫出来，约 0.8 秒，中间数字同步从 0 涨到 `126`。
  - Value by location 的横条从左往右长出来。
- **8.0–9.3 秒：详情页静止。**
  - Value by location 卡片：In room `$16,574`、Seasonal Box `$201`。
  - In room 列表：每行是物品小图、名称、品牌、金额和箭头。
- **约 9.4 秒：从屏幕左边缘往右滑，返回报表页**，报表页保持刚才的滚动位置。

## 页面数据（照这些写死）

**报表页**

- 类别图例（两列）：Electronics、Clothing、Home、Sports、Accessories、Outdoor、Grocery、Books、Tools、Care、Container、Kitchen、Other、Documents。各类的颜色和环形图上的扇区比例照关键帧估。
- 选中 Clothing 时：38 Items、5 Rooms、$5,128。选中 Home 时：34 Items、4 Rooms、$1,462。
- Value by room（从大到小）：Bedroom $16,775、Living Room $6,447、Desktop $3,760、Garage $2,986、Kitchen $846。
- By room 列表：

| 房间 | 副标题 | 金额 | 封面图 |
|---|---|---|---|
| Bedroom | 126 items · 1 container | $16,775 | room-bedroom |
| Desktop | 12 items | $3,760 | room-study |
| Living Room | 35 items · 1 container | $6,447 | room-living |
| Kitchen | 30 items · 1 container | $846 | room-kitchen |
| Garage | 33 items · 3 containers | $2,986 | room-garage |

**Bedroom 详情页**

- 统计卡：126 Items、1 Containers、$16,775 Total value。
- 类别图例：Clothing、Electronics、Home、Accessories、Sports、Books、Outdoor、Tools、Care、Documents、Other、Container。
- Value by location：In room $16,574、Seasonal Box $201。
- In room 列表：

| 物品 | 品牌 | 金额 | 小图 |
|---|---|---|---|
| Label Marker | Sharpie | $4 | pen |
| Cable Box | Anker | $45 | charger |
| Blue-light Glasses | Felix Gray | $95 | sunglasses |
| Reading Light | Glocusent | $25 | hiking-headlamp |
| Old Watch | Casio · SN 407246 | $22 | watch |

其他房间的详情页不用做，点了没反应也可以。
