在当前目录从零搭一个「会员订阅」后端服务。技术栈固定：Cloudflare Workers（TypeScript）+ D1 数据库，用 wrangler 本地开发。目录里已经装好了 wrangler（见 package.json），需要别的依赖可以自己加。

## 背景

App 的内购由第三方订阅平台处理。用户开通、续订、取消、过期、退款时，平台会把事件推送到我们的服务器。我们要据此维护每个用户的会员状态，并提供查询接口给自己的其他服务用。

## 接口约定（必须严格照这个实现，验收测试按这个调用）

### 1. 接收订阅事件

`POST /v1/webhooks/subscription`

- 请求头 `Authorization: Bearer <WEBHOOK_SECRET>`，密钥来自环境变量 `WEBHOOK_SECRET`。缺少或不对，返回 401。
- 请求体 JSON：

```json
{ "event": { "id": "evt_123", "type": "INITIAL_PURCHASE", "app_user_id": "user_1", "product_id": "pro_monthly", "event_timestamp_ms": 1730000000000, "expiration_at_ms": 1732592000000 } }
```

- `type` 取值：`INITIAL_PURCHASE`、`RENEWAL`、`CANCELLATION`、`UNCANCELLATION`、`EXPIRATION`、`REFUND`。
- 处理成功（包括重复推送的事件、不认识的 type）返回 200 和 `{"ok": true}`。
- 请求体不是合法 JSON，或者缺少 `id`、`type`、`app_user_id`、`event_timestamp_ms`，返回 400。

### 2. 查询会员状态

`GET /v1/users/{app_user_id}/subscription`

- 请求头 `Authorization: Bearer <API_TOKEN>`，令牌来自环境变量 `API_TOKEN`。缺少或不对，返回 401。
- 返回 200：

```json
{ "app_user_id": "user_1", "status": "active", "active": true, "product_id": "pro_monthly", "expires_at_ms": 1732592000000, "will_renew": true }
```

- `status` 取值：`none`（从没订阅过）、`active`、`cancelled`（已取消续订但还没到期）、`expired`、`refunded`。
- `active` 表示此刻是否享有会员权益。

## 业务规则

- `INITIAL_PURCHASE`、`RENEWAL`、`UNCANCELLATION`：会员有效到 `expiration_at_ms`，会自动续订。
- `CANCELLATION`：不再续订，但到期前仍然享有权益。
- `EXPIRATION`：会员结束。
- `REFUND`：立刻失去权益。
- 订阅平台可能重复推送同一个事件，也可能乱序推送（旧事件晚到）。同一个事件 id 只能处理一次；一个用户的状态以事件发生时间（`event_timestamp_ms`）最新的那条为准，旧事件晚到不能覆盖新状态。
- 同一个用户的多个事件可能同时到达。

## 交付要求

- wrangler 配置文件里 D1 的绑定名叫 `DB`；数据库迁移放在 `migrations/` 目录，用 `npx wrangler d1 migrations apply DB --local` 能建好表。
- 本地用 `npx wrangler dev --local` 能启动。密钥和令牌从环境变量读（本地放在 `.dev.vars`），不要写死在代码里。
- 自己写测试验证上面的规则。
- 不要部署，不要登录 Cloudflare 账号。
