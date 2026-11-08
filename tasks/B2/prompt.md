在当前目录从零搭一个「家庭物品与过期提醒」后端服务。技术栈固定：Cloudflare Workers（TypeScript）+ D1 数据库，用 wrangler 本地开发。目录里已经装好了 wrangler（见 package.json），需要别的依赖可以自己加。

## 背景

一家人共用一个 App 记家里的东西：每样东西放在哪（房间 › 柜子 › 格子）、有几个、什么时候过期。家里人用邀请码加入同一个「家庭」，看到同一份数据。快过期的东西每天自动生成提醒。家庭可能在世界任何时区，「今天」一律按家庭所在时区算。

## 通用约定（验收测试按这个调用）

- 所有接口收发 JSON。出错时返回对应状态码，响应体 `{"error": "说明"}`（说明随意）。
- 除了注册和登录，所有接口都要请求头 `Authorization: Bearer <token>`；缺少、无效返回 401。
- 请求体不是合法 JSON、缺必填字段、字段类型或取值不对，返回 400。请求体超过 64 KB 返回 413。
- id 一律是字符串，格式自定。
- 日期一律是 `YYYY-MM-DD` 字符串，必须是真实存在的日期（`2026-02-30`、`2026-2-3` 都是 400）。
- **数据隔离**：用户只能看到、改动自己所在家庭的数据。访问不存在的、或者不属于自己所在家庭的家庭、位置、物品，一律返回 404（不透露它是否存在）。
- 令牌可以是存库的随机串，也可以是签名令牌；用到的签名密钥从环境变量 `TOKEN_SECRET` 读。密码不许明文存库。

## 接口约定

### 1. 账号

- `POST /v1/auth/register`，请求 `{"email": "a@example.com", "password": "至少 8 位"}`。邮箱要含 `@`，密码至少 8 个字符，否则 400。邮箱不区分大小写，已被注册返回 409。成功返回 201：`{"user": {"id": "...", "email": "a@example.com"}, "token": "..."}`（email 一律存成小写）。
- `POST /v1/auth/login`，请求同上。成功返回 200，响应同注册；邮箱或密码不对返回 401。
- `GET /v1/me` 返回 200：`{"id": "...", "email": "..."}`。

### 2. 家庭与成员

- `POST /v1/households`，请求 `{"name": "我家", "timezone": "Asia/Singapore"}`。`timezone` 必须是合法的 IANA 时区名，否则 400；`name` 不能为空。建的人是这个家庭的 owner。返回 201：`{"id": "...", "name": "我家", "timezone": "Asia/Singapore", "role": "owner"}`。
- `GET /v1/households` 返回 200：`{"households": [ 同上结构, ... ]}`，只列我所在的家庭，`role` 是我在该家庭的角色（`owner` 或 `member`）。
- `GET /v1/households/{household_id}` 返回 200，结构同上。
- `POST /v1/households/{household_id}/invites` 生成邀请码。只有 owner 能生成，普通成员返回 403。返回 201：`{"code": "...", "expires_at_ms": 1730000000000}`。邀请码 24 小时内有效、只能用一次。
- `POST /v1/invites/{code}/accept` 用邀请码加入。成功返回 200：`{"household": { 同家庭结构，role 为 "member" }}`。邀请码不存在返回 404；已经用过或已过期返回 410；我已经是这个家庭的成员返回 409（这种情况不消耗邀请码）。
- `GET /v1/households/{household_id}/members` 返回 200：`{"members": [{"user_id": "...", "email": "...", "role": "owner"}, ...]}`。
- `DELETE /v1/households/{household_id}/members/{user_id}`：
  - 成员删自己 = 退出家庭，返回 204；
  - owner 删别的成员 = 踢人，返回 204；
  - owner 删自己返回 400（owner 不能退出）；普通成员删别人返回 403；目标不是这个家庭的成员返回 404。
  - 退出或被踢之后，这个人再访问这个家庭的任何数据都是 404。

### 3. 存放位置

- `POST /v1/households/{household_id}/locations`，请求 `{"name": "卧室", "parent_id": null}`。`parent_id` 为空是第一层（房间），指向房间是第二层（柜子），指向柜子是第三层（格子）；最多三层，再往下建返回 400。`parent_id` 不是本家庭的位置返回 400。返回 201：`{"id": "...", "name": "卧室", "parent_id": null}`。
- `GET /v1/households/{household_id}/locations` 按树返回 200：`{"locations": [{"id": "...", "name": "卧室", "parent_id": null, "children": [{"id": "...", "name": "衣柜", "parent_id": "...", "children": [...]}]}]}`。每个节点都有 `children`（没有就是空数组）。
- `DELETE /v1/households/{household_id}/locations/{location_id}`：成功 204；下面还有子位置或物品返回 409。

### 4. 物品

物品结构：

```json
{ "id": "...", "name": "牛奶", "quantity": 2, "location_id": "...", "expires_on": "2026-11-20", "days_left": 3 }
```

- `location_id` 可以为 null；不为 null 时必须是本家庭的位置，否则 400。
- `quantity` 是非负整数，不填默认 1。
- `expires_on` 可以为 null（不会过期）。
- `days_left` 由服务端算：`expires_on` 减去家庭所在时区的「今天」的天数（今天到期是 0，昨天到期是 -1）；`expires_on` 为 null 时 `days_left` 也是 null。

接口：

- `POST /v1/households/{household_id}/items`，请求 `{"name": "牛奶", "quantity": 2, "location_id": "...", "expires_on": "2026-11-20"}`，`name` 必填。返回 201 和物品。
- `GET /v1/households/{household_id}/items/{item_id}` 返回 200 和物品。
- `PATCH /v1/households/{household_id}/items/{item_id}` 部分更新，只改请求里出现的字段；字段给 null 表示清空（`name` 不能清空）。校验同新建。返回 200 和更新后的物品。
- `DELETE /v1/households/{household_id}/items/{item_id}` 返回 204。
- `GET /v1/households/{household_id}/items` 列表，返回 200：`{"items": [...], "next_cursor": "..." 或 null}`。查询参数：
  - `limit`：每页条数，1–100，默认 20；超出范围或不是整数返回 400。
  - `cursor`：上一页返回的 `next_cursor`，原样带回；无法识别返回 400。没有下一页时 `next_cursor` 为 null。
  - `expiring_within_days=N`（0–365 的整数）：只列 `expires_on` 在家庭时区的今天到今天 + N 天之间（含两端）的物品。
  - `expired=true`：只列已经过期（`expires_on` 早于家庭时区的今天）的物品。
  - 排序：带 `expiring_within_days` 或 `expired` 时按 `expires_on` 从早到晚，同一天按创建先后；不带时按创建先后。
  - 翻页必须不重不漏：从第一页一直翻到最后一页，每个物品正好出现一次；翻页途中删掉已经返回过的物品（包括上一页的最后一条），后面的页照样接着往下，不重不漏。

### 5. 过期提醒

- Worker 要有定时任务（`scheduled` 处理器，wrangler 配置里加 cron `0 * * * *`，每小时一次）。每次运行时，对每个家庭，以**这次触发的时刻**（`event.scheduledTime`，不是机器的当前时间）在家庭时区的日期作为「今天」，给 `expires_on` 在今天到今天 + 3 天之间（含两端）的物品各生成一条提醒，`remind_on` 是这个「今天」。已过期的、没有过期日的不生成。
- 同一个物品同一个 `remind_on` 最多一条提醒：同一天里定时任务重复触发、多次同时触发，都不能生成重复的提醒。到了家庭时区的第二天再触发，还在范围内的物品会生成新一天的提醒。
- `GET /v1/households/{household_id}/reminders` 返回 200：`{"reminders": [{"id": "...", "item_id": "...", "item_name": "牛奶", "expires_on": "2026-11-20", "remind_on": "2026-11-18"}, ...]}`，按 `remind_on`、再按 `expires_on` 从早到晚。
- 验收时用 `npx wrangler dev --local` 起服务，通过 `GET /cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=<毫秒时间戳>` 触发定时任务（wrangler 本地自带的入口，`time` 会成为 `event.scheduledTime`）。

## 交付要求

- wrangler 配置文件里 D1 的绑定名叫 `DB`；数据库迁移放在 `migrations/` 目录，用 `npx wrangler d1 migrations apply DB --local` 能建好表。
- 本地用 `npx wrangler dev --local` 能启动。密钥从环境变量读（本地放在 `.dev.vars`），不要写死在代码里。
- 多个请求可能同时到达（比如很多人同时用同一个邀请码、同一个邮箱同时注册），结果必须和一个一个来时一样正确。
- 自己写测试验证上面的规则。
- 不要部署，不要登录 Cloudflare 账号。
