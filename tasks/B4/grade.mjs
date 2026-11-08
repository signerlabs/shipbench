// B4 会员订阅回调：隐藏的接口验收测试。在工具做完的目录里运行：node grade.mjs <结果.json>
// 写好 .dev.vars、应用迁移、起本地服务，按接口约定逐条调用，输出每条通过与否。
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const HOOK = 'hook_test_secret_7f3a';
const API = 'api_test_token_91c2';
const out = process.argv[2] || 'grade-result.json';
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };

writeFileSync('.dev.vars', `WEBHOOK_SECRET=${HOOK}\nAPI_TOKEN=${API}\n`);
const result = { setup: {}, cases: [] };
try {
  result.setup.migrate = execSync('npx wrangler d1 migrations apply DB --local 2>&1', { env, timeout: 180000 }).toString().slice(-600);
  result.setup.migrateOk = true;
} catch (e) {
  result.setup.migrateOk = false;
  result.setup.migrate = String(e.stdout || e.message).slice(-600);
}

const server = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { await fetch(BASE + '/'); return true; } catch { await sleep(1000); }
  }
  return false;
}

const DAY = 86400000;
const now = Date.now();
const future = now + 30 * DAY;
const past = now - 2 * DAY;
let seq = 0;
const ev = (user, type, ts, exp = future, extra = {}) => ({ event: { id: `evt_${user}_${type}_${ts}_${seq++}`, type, app_user_id: user, product_id: 'pro_monthly', event_timestamp_ms: ts, expiration_at_ms: exp, ...extra } });
async function hook(body, auth = `Bearer ${HOOK}`, raw = false) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return fetch(BASE + '/v1/webhooks/subscription', { method: 'POST', headers, body: raw ? body : JSON.stringify(body) });
}
async function sub(user, auth = `Bearer ${API}`) {
  const headers = {};
  if (auth) headers.authorization = auth;
  return fetch(`${BASE}/v1/users/${encodeURIComponent(user)}/subscription`, { headers });
}
async function state(user) { const r = await sub(user); return r.status === 200 ? r.json() : { httpStatus: r.status }; }

const cases = [
  ['事件接口缺少密钥返回 401', async () => (await hook(ev('a1', 'INITIAL_PURCHASE', now), null)).status === 401],
  ['事件接口密钥不对返回 401', async () => (await hook(ev('a1', 'INITIAL_PURCHASE', now), 'Bearer wrong')).status === 401],
  ['请求体不是合法 JSON 返回 400', async () => (await hook('{not json', `Bearer ${HOOK}`, true)).status === 400],
  ['缺少必填字段返回 400', async () => (await hook({ event: { type: 'RENEWAL', app_user_id: 'a1' } })).status === 400],
  ['查询接口缺少令牌返回 401', async () => (await sub('a1', null)).status === 401],
  ['从没订阅过的用户：status none、active false', async () => { const s = await state('never_seen'); return s.status === 'none' && s.active === false; }],
  ['开通后：active、会续订、到期时间和商品对', async () => {
    const r = await hook(ev('u_new', 'INITIAL_PURCHASE', now - 5000));
    const s = await state('u_new');
    return r.status === 200 && s.status === 'active' && s.active === true && s.will_renew === true && s.expires_at_ms === future && s.product_id === 'pro_monthly';
  }],
  ['取消续订：status cancelled，到期前仍 active，不再续订', async () => {
    await hook(ev('u_new', 'CANCELLATION', now - 4000));
    const s = await state('u_new');
    return s.status === 'cancelled' && s.active === true && s.will_renew === false;
  }],
  ['恢复续订：回到 active、会续订', async () => {
    await hook(ev('u_new', 'UNCANCELLATION', now - 3000));
    const s = await state('u_new');
    return s.status === 'active' && s.active === true && s.will_renew === true;
  }],
  ['过期：status expired、active false', async () => {
    await hook(ev('u_new', 'EXPIRATION', now - 2000, past));
    const s = await state('u_new');
    return s.status === 'expired' && s.active === false;
  }],
  ['退款：即使没到期也立刻失去权益', async () => {
    await hook(ev('u_ref', 'INITIAL_PURCHASE', now - 5000));
    await hook(ev('u_ref', 'REFUND', now - 1000));
    const s = await state('u_ref');
    return s.status === 'refunded' && s.active === false;
  }],
  ['同一事件重复推送只处理一次（旧的开通事件重推不能把过期改回去）', async () => {
    const first = ev('u_dup', 'INITIAL_PURCHASE', now - 9000);
    await hook(first);
    await hook(ev('u_dup', 'EXPIRATION', now - 8000, past));
    const again = await hook(first);
    const s = await state('u_dup');
    return again.status === 200 && s.status === 'expired' && s.active === false;
  }],
  ['乱序：旧的过期事件晚到，不能覆盖新的续订', async () => {
    await hook(ev('u_ooo', 'RENEWAL', now - 1000));
    await hook(ev('u_ooo', 'EXPIRATION', now - 50000, past));
    const s = await state('u_ooo');
    return s.status === 'active' && s.active === true && s.expires_at_ms === future;
  }],
  ['不认识的事件类型：返回 200，状态不变', async () => {
    await hook(ev('u_unk', 'INITIAL_PURCHASE', now - 5000));
    const r = await hook(ev('u_unk', 'PRODUCT_CHANGE_SOMETHING', now - 1000, past));
    const s = await state('u_unk');
    return r.status === 200 && s.status === 'active' && s.expires_at_ms === future;
  }],
  ['同时到达 10 条续订：最后以发生时间最新的那条为准', async () => {
    const evs = Array.from({ length: 10 }, (_, i) => ev('u_par', 'RENEWAL', now - 20000 + i * 100, future + i * DAY));
    const shuffled = evs.slice().sort(() => Math.random() - 0.5);
    const rs = await Promise.all(shuffled.map((e) => hook(e)));
    const s = await state('u_par');
    return rs.every((r) => r.status === 200) && s.expires_at_ms === future + 9 * DAY && s.active === true;
  }],
  ['到期时间已过的开通事件：status 照记，但 active false', async () => {
    await hook(ev('u_old', 'INITIAL_PURCHASE', now - 5 * DAY, past));
    const s = await state('u_old');
    return s.active === false;
  }],
  ['返回字段齐全（app_user_id、status、active、product_id、expires_at_ms、will_renew）', async () => {
    const s = await state('u_ooo');
    return ['app_user_id', 'status', 'active', 'product_id', 'expires_at_ms', 'will_renew'].every((k) => k in s) && s.app_user_id === 'u_ooo';
  }],
];

const up = await waitUp();
result.setup.serverUp = up;
for (const [name, fn] of cases) {
  let ok = false, err = '';
  if (up) { try { ok = await fn(); } catch (e) { err = String(e.message || e); } }
  result.cases.push({ name, ok, err });
}
server.kill('SIGINT');
await sleep(1500);
try { server.kill('SIGKILL'); } catch {}
result.passed = result.cases.filter((c) => c.ok).length;
result.total = result.cases.length;
result.score = Math.round((result.passed / result.total) * 100);
result.serverLogTail = log.slice(-1500);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`B4 ${result.passed}/${result.total} 分数 ${result.score}${up ? '' : '（服务没起来）'}`);
process.exit(0);
