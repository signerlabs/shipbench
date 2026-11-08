// B2 家庭物品与过期提醒：隐藏的接口验收测试。在工具做完的目录里运行：node grade.mjs <结果.json>
// 写好 .dev.vars、应用迁移、起本地服务，按题面的接口约定逐条调用，输出每条通过与否。
// 用例按执行顺序排，后面的会用到前面建好的账号、家庭和物品；每条带块名：功能、鉴权与隔离、健壮性。
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const out = process.argv[2] || 'grade-result.json';
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };

writeFileSync('.dev.vars', 'TOKEN_SECRET=grade_token_secret_5d1e8b\n');
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

// ---------- 工具 ----------
async function api(method, path, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) { payload = raw; h['content-type'] = 'application/json'; }
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + path, { method, headers: h, body: payload });
  let data = null;
  const text = await r.text();
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: r.status, data };
}
const localDate = (tz, ms = Date.now()) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
const RUN = Date.now().toString(36);
const mail = (name) => `${name}.${RUN}@example.com`;
const PW = 'correct-horse-9';

async function register(name, pw = PW) {
  const r = await api('POST', '/v1/auth/register', { body: { email: mail(name), password: pw } });
  return r.status === 201 && r.data?.token ? { token: r.data.token, id: r.data.user?.id, email: r.data.user?.email } : null;
}
async function household(token, name, timezone) {
  const r = await api('POST', '/v1/households', { token, body: { name, timezone } });
  return r.status === 201 ? r.data : null;
}
async function item(token, hid, body) {
  const r = await api('POST', `/v1/households/${hid}/items`, { token, body });
  return r.status === 201 ? r.data : null;
}
async function pageAll(token, hid, query, limit) {
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ ...query, limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    const r = await api('GET', `/v1/households/${hid}/items?${q}`, { token });
    if (r.status !== 200 || !Array.isArray(r.data?.items)) return null;
    seen.push(...r.data.items);
    cursor = r.data.next_cursor;
    if (!cursor) return seen;
  }
  return null;
}
async function trigger(timeMs) {
  const r = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=${timeMs}`);
  await r.text();
  return r.status;
}
async function reminders(token, hid) {
  const r = await api('GET', `/v1/households/${hid}/reminders`, { token });
  return r.status === 200 && Array.isArray(r.data?.reminders) ? r.data.reminders : null;
}
// 定时任务可能用 waitUntil 在后台写库：等提醒条数稳定下来再读
async function settledReminders(token, hid) {
  await sleep(800);
  let last = await reminders(token, hid);
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const now = await reminders(token, hid);
    if (JSON.stringify(now) === JSON.stringify(last)) return now;
    last = now;
  }
  return last;
}
const key = (r) => `${r.item_id}@${r.remind_on}`;
const noDup = (list) => new Set(list.map(key)).size === list.length;

// ---------- 状态 ----------
const S = {};
const T = (() => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 11, 30); })(); // UTC 11:30：基里巴斯是次日 01:30，帕果帕果是当天 00:30
const KTZ = 'Pacific/Kiritimati';
const PTZ = 'Pacific/Pago_Pago';
const pToday = localDate(PTZ, T);
const d = (n) => addDays(pToday, n);

const cases = [
  // ===== 账号 =====
  ['功能', '注册返回 201，带 token，邮箱存成小写', async () => {
    const r = await api('POST', '/v1/auth/register', { body: { email: `Alice.${RUN}@Example.com`, password: PW } });
    S.a = { token: r.data?.token, id: r.data?.user?.id };
    return r.status === 201 && typeof r.data?.token === 'string' && r.data?.user?.email === `alice.${RUN}@example.com`;
  }],
  ['功能', '登录返回 200 和可用的令牌，GET /v1/me 返回自己', async () => {
    const r = await api('POST', '/v1/auth/login', { body: { email: `alice.${RUN}@example.com`, password: PW } });
    if (r.status !== 200 || !r.data?.token) return false;
    S.a.token = r.data.token;
    const me = await api('GET', '/v1/me', { token: S.a.token });
    return me.status === 200 && me.data?.id === S.a.id && me.data?.email === `alice.${RUN}@example.com`;
  }],
  ['鉴权与隔离', '密码不对登录返回 401', async () => (await api('POST', '/v1/auth/login', { body: { email: `alice.${RUN}@example.com`, password: 'wrong-password-1' } })).status === 401],
  ['健壮性', '邮箱大小写不同也算重复注册，返回 409', async () => (await api('POST', '/v1/auth/register', { body: { email: `ALICE.${RUN}@EXAMPLE.COM`, password: PW } })).status === 409],
  ['健壮性', '注册：坏 JSON、缺密码、密码少于 8 位、邮箱没有 @ 都返回 400', async () => {
    const rs = await Promise.all([
      api('POST', '/v1/auth/register', { raw: '{"email": ' }),
      api('POST', '/v1/auth/register', { body: { email: mail('nopw') } }),
      api('POST', '/v1/auth/register', { body: { email: mail('short'), password: '1234567' } }),
      api('POST', '/v1/auth/register', { body: { email: 'no-at-sign.example.com', password: PW } }),
    ]);
    return rs.every((r) => r.status === 400);
  }],
  ['鉴权与隔离', '没带令牌、令牌无效都返回 401', async () => {
    const a = await api('GET', '/v1/households');
    const b = await api('GET', '/v1/households', { token: 'not-a-real-token' });
    const c = await api('GET', '/v1/me', { headers: { authorization: 'Basic abc' } });
    return a.status === 401 && b.status === 401 && c.status === 401;
  }],
  // ===== 家庭 =====
  ['功能', '建家庭返回 201，建的人是 owner，时区原样返回', async () => {
    const r = await api('POST', '/v1/households', { token: S.a.token, body: { name: 'A 家', timezone: 'Asia/Singapore' } });
    S.ha = r.data?.id;
    return r.status === 201 && r.data?.role === 'owner' && r.data?.timezone === 'Asia/Singapore' && r.data?.name === 'A 家' && !!S.ha;
  }],
  ['健壮性', '非法时区、空名字建家庭返回 400', async () => {
    const a = await api('POST', '/v1/households', { token: S.a.token, body: { name: 'X', timezone: 'Mars/Olympus_Mons' } });
    const b = await api('POST', '/v1/households', { token: S.a.token, body: { name: '', timezone: 'UTC' } });
    const c = await api('POST', '/v1/households', { token: S.a.token, body: { name: 'X' } });
    return a.status === 400 && b.status === 400 && c.status === 400;
  }],
  ['功能', '家庭列表只列自己所在的家庭', async () => {
    S.b = await register('bob');
    S.hb = (await household(S.b.token, 'B 家', 'Europe/Berlin'))?.id;
    const la = await api('GET', '/v1/households', { token: S.a.token });
    const lb = await api('GET', '/v1/households', { token: S.b.token });
    const ida = (la.data?.households || []).map((h) => h.id);
    const idb = (lb.data?.households || []).map((h) => h.id);
    return la.status === 200 && ida.includes(S.ha) && !ida.includes(S.hb) && idb.includes(S.hb) && !idb.includes(S.ha);
  }],
  ['鉴权与隔离', '不是成员读别人的家庭返回 404', async () => (await api('GET', `/v1/households/${S.ha}`, { token: S.b.token })).status === 404],
  ['功能', 'owner 生成邀请码 201，别人用码加入返回 200、角色 member', async () => {
    S.c = await register('carol');
    const inv = await api('POST', `/v1/households/${S.ha}/invites`, { token: S.a.token });
    const acc = await api('POST', `/v1/invites/${encodeURIComponent(inv.data?.code)}/accept`, { token: S.c.token });
    return inv.status === 201 && typeof inv.data?.code === 'string' && typeof inv.data?.expires_at_ms === 'number'
      && acc.status === 200 && acc.data?.household?.id === S.ha && acc.data?.household?.role === 'member';
  }],
  ['功能', '成员列表有 owner 和新成员，角色对', async () => {
    const r = await api('GET', `/v1/households/${S.ha}/members`, { token: S.c.token });
    const m = r.data?.members || [];
    const role = (id) => m.find((x) => x.user_id === id)?.role;
    return r.status === 200 && m.length === 2 && role(S.a.id) === 'owner' && role(S.c.id) === 'member';
  }],
  ['鉴权与隔离', '普通成员生成邀请码返回 403', async () => (await api('POST', `/v1/households/${S.ha}/invites`, { token: S.c.token })).status === 403],
  ['鉴权与隔离', '已经是成员再用邀请码返回 409，而且不消耗这个码', async () => {
    const inv = await api('POST', `/v1/households/${S.ha}/invites`, { token: S.a.token });
    S.code2 = inv.data?.code;
    const again = await api('POST', `/v1/invites/${encodeURIComponent(S.code2)}/accept`, { token: S.c.token });
    S.e = await register('erin');
    const fresh = await api('POST', `/v1/invites/${encodeURIComponent(S.code2)}/accept`, { token: S.e.token });
    return again.status === 409 && fresh.status === 200;
  }],
  ['鉴权与隔离', '用过的邀请码再用返回 410，不存在的码返回 404', async () => {
    const f = await register('frank');
    const used = await api('POST', `/v1/invites/${encodeURIComponent(S.code2)}/accept`, { token: f.token });
    const none = await api('POST', '/v1/invites/no-such-code-123/accept', { token: f.token });
    return used.status === 410 && none.status === 404;
  }],
  // 并发用例：本地 wrangler 里同一批并发请求的第一个总会先跑十来毫秒，所以每轮先发一个「诱饵」请求（碰库但不改结果）吃掉这段，
  // 后面的请求才真正同时到；竞态是概率性的，所以多跑几轮，任何一轮出错都算没过
  ['健壮性', '10 个人同时用同一个邀请码，只有 1 个成功，其余 410（5 轮）', async () => {
    const hc = await household(S.a.token, '并发家', 'UTC');
    for (let round = 0; round < 5; round++) {
      const users = [];
      for (let i = 0; i < 10; i++) users.push(await register(`racer${round}x${i}`));
      const inv = await api('POST', `/v1/households/${hc.id}/invites`, { token: S.a.token });
      const path = `/v1/invites/${encodeURIComponent(inv.data.code)}/accept`;
      const [decoy, ...rs] = await Promise.all([api('POST', path, { token: S.a.token }), ...users.map((u) => api('POST', path, { token: u.token }))]);
      const ok = rs.filter((r) => r.status === 200).length;
      const gone = rs.filter((r) => r.status === 410).length;
      if (decoy.status !== 409 || ok !== 1 || gone !== 9) return false;
    }
    const mem = await api('GET', `/v1/households/${hc.id}/members`, { token: S.a.token });
    return (mem.data?.members || []).length === 6;
  }],
  ['健壮性', '同一邮箱 5 个注册同时到，只有 1 个成功，其余 409（3 轮）', async () => {
    for (let round = 0; round < 3; round++) {
      const email = mail(`twin${round}`);
      const [decoy, ...rs] = await Promise.all([
        api('POST', '/v1/auth/login', { body: { email: `alice.${RUN}@example.com`, password: PW } }),
        ...Array.from({ length: 5 }, () => api('POST', '/v1/auth/register', { body: { email, password: PW } })),
      ]);
      if (decoy.status !== 200 || rs.filter((r) => r.status === 201).length !== 1 || rs.filter((r) => r.status === 409).length !== 4) return false;
    }
    return true;
  }],
  // ===== 位置 =====
  ['功能', '三层位置（房间 › 柜子 › 格子）按树返回', async () => {
    const room = await api('POST', `/v1/households/${S.ha}/locations`, { token: S.a.token, body: { name: '卧室', parent_id: null } });
    const cab = await api('POST', `/v1/households/${S.ha}/locations`, { token: S.a.token, body: { name: '衣柜', parent_id: room.data?.id } });
    const shelf = await api('POST', `/v1/households/${S.ha}/locations`, { token: S.c.token, body: { name: '第二格', parent_id: cab.data?.id } });
    S.room = room.data?.id; S.cab = cab.data?.id; S.shelf = shelf.data?.id;
    const t = await api('GET', `/v1/households/${S.ha}/locations`, { token: S.a.token });
    const r = (t.data?.locations || []).find((x) => x.id === S.room);
    const c = r?.children?.find((x) => x.id === S.cab);
    const s = c?.children?.find((x) => x.id === S.shelf);
    return room.status === 201 && cab.status === 201 && shelf.status === 201 && cab.data?.parent_id === S.room
      && t.status === 200 && !!s && s.name === '第二格' && Array.isArray(s.children) && s.children.length === 0 && r.parent_id === null;
  }],
  ['健壮性', '在第三层下面再建位置返回 400', async () => (await api('POST', `/v1/households/${S.ha}/locations`, { token: S.a.token, body: { name: '小盒子', parent_id: S.shelf } })).status === 400],
  // ===== 物品 =====
  ['功能', '新建物品返回 201，数量默认 1，days_left 按家庭时区算', async () => {
    const exp = addDays(localDate('Asia/Singapore'), 5);
    const r = await api('POST', `/v1/households/${S.ha}/items`, { token: S.c.token, body: { name: '牛奶', location_id: S.shelf, expires_on: exp } });
    S.milk = r.data?.id;
    const expect = [dayNum(exp) - dayNum(localDate('Asia/Singapore'))];
    return r.status === 201 && r.data?.quantity === 1 && r.data?.location_id === S.shelf && r.data?.expires_on === exp && expect.includes(r.data?.days_left) && !!S.milk;
  }],
  ['功能', '读物品返回 200 和同样的字段', async () => {
    const r = await api('GET', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.a.token });
    return r.status === 200 && r.data?.id === S.milk && r.data?.name === '牛奶' && r.data?.location_id === S.shelf && 'days_left' in r.data;
  }],
  ['功能', 'PATCH 只改请求里的字段', async () => {
    const r = await api('PATCH', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.a.token, body: { quantity: 3 } });
    return r.status === 200 && r.data?.quantity === 3 && r.data?.name === '牛奶' && r.data?.location_id === S.shelf && typeof r.data?.expires_on === 'string';
  }],
  ['功能', 'PATCH 把过期日和位置给 null 就清空，days_left 也变 null', async () => {
    const r = await api('PATCH', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.a.token, body: { expires_on: null, location_id: null } });
    const g = await api('GET', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.a.token });
    return r.status === 200 && r.data?.expires_on === null && r.data?.days_left === null && g.data?.expires_on === null && g.data?.location_id === null && g.data?.quantity === 3;
  }],
  ['健壮性', '物品：坏 JSON、缺名字、不存在的日期、格式不对的日期都返回 400', async () => {
    const p = `/v1/households/${S.ha}/items`;
    const rs = await Promise.all([
      api('POST', p, { token: S.a.token, raw: '{oops' }),
      api('POST', p, { token: S.a.token, body: { quantity: 1 } }),
      api('POST', p, { token: S.a.token, body: { name: '坏日期', expires_on: '2026-02-30' } }),
      api('POST', p, { token: S.a.token, body: { name: '坏日期', expires_on: '2026-2-3' } }),
      api('PATCH', `${p}/${S.milk}`, { token: S.a.token, body: { expires_on: '2025-13-01' } }),
    ]);
    return rs.every((r) => r.status === 400);
  }],
  ['健壮性', '数量是负数或小数返回 400', async () => {
    const p = `/v1/households/${S.ha}/items`;
    const a = await api('POST', p, { token: S.a.token, body: { name: '负数', quantity: -1 } });
    const b = await api('POST', p, { token: S.a.token, body: { name: '小数', quantity: 1.5 } });
    return a.status === 400 && b.status === 400;
  }],
  ['健壮性', '请求体超过 64 KB 返回 413', async () => (await api('POST', `/v1/households/${S.ha}/items`, { token: S.a.token, body: { name: 'x'.repeat(70000) } })).status === 413],
  ['健壮性', '位置下还有子位置或物品时删除返回 409', async () => {
    const box = await item(S.a.token, S.ha, { name: '围巾', location_id: S.shelf });
    S.scarf = box?.id;
    const a = await api('DELETE', `/v1/households/${S.ha}/locations/${S.cab}`, { token: S.a.token });
    const b = await api('DELETE', `/v1/households/${S.ha}/locations/${S.shelf}`, { token: S.a.token });
    return a.status === 409 && b.status === 409;
  }],
  ['功能', '删除物品返回 204，之后读返回 404；空的位置能删', async () => {
    const del = await api('DELETE', `/v1/households/${S.ha}/items/${S.scarf}`, { token: S.a.token });
    const g = await api('GET', `/v1/households/${S.ha}/items/${S.scarf}`, { token: S.a.token });
    const dl = await api('DELETE', `/v1/households/${S.ha}/locations/${S.shelf}`, { token: S.a.token });
    return del.status === 204 && g.status === 404 && dl.status === 204;
  }],
  ['鉴权与隔离', '不是成员列别人家的物品、读别人家的位置返回 404', async () => {
    const a = await api('GET', `/v1/households/${S.ha}/items`, { token: S.b.token });
    const b = await api('GET', `/v1/households/${S.ha}/locations`, { token: S.b.token });
    const c = await api('GET', `/v1/households/${S.ha}/reminders`, { token: S.b.token });
    return a.status === 404 && b.status === 404 && c.status === 404;
  }],
  ['鉴权与隔离', '拿别人家物品的 id 走自己家的路径读、改、删都返回 404', async () => {
    const p = `/v1/households/${S.hb}/items/${S.milk}`;
    const g = await api('GET', p, { token: S.b.token });
    const u = await api('PATCH', p, { token: S.b.token, body: { name: '偷改' } });
    const x = await api('DELETE', p, { token: S.b.token });
    const still = await api('GET', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.a.token });
    return g.status === 404 && u.status === 404 && x.status === 404 && still.data?.name === '牛奶';
  }],
  ['鉴权与隔离', '新建物品时用别人家的位置返回 400，删别人家的位置返回 404', async () => {
    const a = await api('POST', `/v1/households/${S.hb}/items`, { token: S.b.token, body: { name: '越界', location_id: S.room } });
    const b = await api('DELETE', `/v1/households/${S.hb}/locations/${S.room}`, { token: S.b.token });
    const c = await api('DELETE', `/v1/households/${S.ha}/locations/${S.room}`, { token: S.b.token });
    return a.status === 400 && b.status === 404 && c.status === 404;
  }],
  // ===== 列表与过滤 =====
  ['功能', 'expiring_within_days 按家庭时区的今天过滤（含两端），按过期日排序', async () => {
    const tz = 'America/Los_Angeles';
    const hf = await household(S.a.token, '洛杉矶的家', tz);
    S.hf = hf?.id;
    const t = localDate(tz);
    const plan = [['t+3', 3], ['t-1', -1], ['t', 0], ['none', null], ['t+4', 4], ['t+2', 2]];
    for (const [name, n] of plan) await item(S.a.token, S.hf, { name, expires_on: n === null ? null : addDays(t, n) });
    const r = await api('GET', `/v1/households/${S.hf}/items?expiring_within_days=3`, { token: S.a.token });
    const names = (r.data?.items || []).map((x) => x.name);
    const t2 = localDate(tz);
    const ok = (exp) => JSON.stringify(names) === JSON.stringify(exp);
    return r.status === 200 && (ok(['t', 't+2', 't+3']) || (t2 !== t && ok(['t+2', 't+3', 't+4'])));
  }],
  ['功能', 'expired=true 只列已过期的', async () => {
    const r = await api('GET', `/v1/households/${S.hf}/items?expired=true`, { token: S.a.token });
    const names = (r.data?.items || []).map((x) => x.name);
    return r.status === 200 && JSON.stringify(names) === JSON.stringify(['t-1']);
  }],
  ['功能', '翻页：25 个物品每页 7 个，翻完正好 25 个、按创建先后、不重不漏', async () => {
    const hg = await household(S.a.token, '翻页家', 'UTC');
    S.hg = hg?.id;
    S.gnames = Array.from({ length: 25 }, (_, i) => `g${String(i + 1).padStart(2, '0')}`);
    for (const name of S.gnames) await item(S.a.token, S.hg, { name });
    const all = await pageAll(S.a.token, S.hg, {}, 7);
    return !!all && JSON.stringify(all.map((x) => x.name)) === JSON.stringify(S.gnames);
  }],
  ['功能', '翻页途中删掉上一页的最后一条，后面的页照样接着往下', async () => {
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ limit: '7' });
      if (cursor) q.set('cursor', cursor);
      const r = await api('GET', `/v1/households/${S.hg}/items?${q}`, { token: S.a.token });
      if (r.status !== 200) return false;
      const items = r.data.items || [];
      seen.push(...items.map((x) => x.name));
      cursor = r.data.next_cursor;
      if (!cursor) break;
      const last = items[items.length - 1];
      await api('DELETE', `/v1/households/${S.hg}/items/${last.id}`, { token: S.a.token });
    }
    return JSON.stringify(seen) === JSON.stringify(S.gnames);
  }],
  ['功能', '按过期日排序的翻页：同一天的按创建先后，翻完不重不漏', async () => {
    const hh = await household(S.a.token, '同日家', 'UTC');
    const t = localDate('UTC');
    const expect = [];
    for (let i = 0; i < 12; i++) {
      const n = 1 + (i % 3);
      await item(S.a.token, hh.id, { name: `h${i}`, expires_on: addDays(t, n) });
      expect.push([n, i]);
    }
    expect.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const all = await pageAll(S.a.token, hh.id, { expiring_within_days: '5' }, 5);
    return !!all && JSON.stringify(all.map((x) => x.name)) === JSON.stringify(expect.map((e) => `h${e[1]}`));
  }],
  ['健壮性', 'limit 超出 1–100 或不是整数、cursor 乱写都返回 400', async () => {
    const p = `/v1/households/${S.hg}/items`;
    const rs = await Promise.all([
      api('GET', `${p}?limit=0`, { token: S.a.token }),
      api('GET', `${p}?limit=101`, { token: S.a.token }),
      api('GET', `${p}?limit=abc`, { token: S.a.token }),
      api('GET', `${p}?cursor=%25%25not-a-cursor%25%25`, { token: S.a.token }),
    ]);
    return rs.every((r) => r.status === 400);
  }],
  ['健壮性', '时区边界：同一个过期日，基里巴斯（UTC+14）和帕果帕果（UTC−11）的家 days_left 各按自己的今天', async () => {
    const hk = await household(S.a.token, '基里巴斯的家', KTZ);
    const hp = await household(S.a.token, '帕果帕果的家', PTZ);
    S.hk = hk?.id; S.hp = hp?.id;
    const exp = addDays(localDate('UTC'), 2);
    const before = { k: localDate(KTZ), p: localDate(PTZ) };
    const ik = await item(S.a.token, S.hk, { name: 'probe', expires_on: exp });
    const ip = await item(S.a.token, S.hp, { name: 'probe', expires_on: exp });
    const after = { k: localDate(KTZ), p: localDate(PTZ) };
    const okK = [before.k, after.k].map((t) => dayNum(exp) - dayNum(t)).includes(ik?.days_left);
    const okP = [before.p, after.p].map((t) => dayNum(exp) - dayNum(t)).includes(ip?.days_left);
    if (ik) await api('DELETE', `/v1/households/${S.hk}/items/${ik.id}`, { token: S.a.token });
    if (ip) await api('DELETE', `/v1/households/${S.hp}/items/${ip.id}`, { token: S.a.token });
    return okK && okP && ik.days_left !== ip.days_left;
  }],
  // ===== 定时任务 =====
  ['功能', '定时任务：按触发时刻在家庭时区的「今天」，给 3 天内过期的物品生成提醒（UTC−11 的家）', async () => {
    S.sched = {};
    for (const [label, hid] of [['k', S.hk], ['p', S.hp]]) {
      S.sched[label] = {};
      for (const n of [-1, 0, 1, 3, 4, 5]) S.sched[label][n] = (await item(S.a.token, hid, { name: `d${n}`, expires_on: d(n) }))?.id;
      await item(S.a.token, hid, { name: 'never' });
    }
    if (await trigger(T) !== 200) return false;
    const rp = await settledReminders(S.a.token, S.hp);
    const got = (rp || []).map((r) => `${r.item_id}@${r.remind_on}`).sort();
    const want = [0, 1, 3].map((n) => `${S.sched.p[n]}@${d(0)}`).sort();
    return JSON.stringify(got) === JSON.stringify(want);
  }],
  ['功能', '定时任务：同一时刻，UTC+14 的家按它自己的「今天」（已是次日）生成', async () => {
    const rk = await settledReminders(S.a.token, S.hk);
    const got = (rk || []).map((r) => `${r.item_id}@${r.remind_on}`).sort();
    const want = [1, 3, 4].map((n) => `${S.sched.k[n]}@${d(1)}`).sort();
    return JSON.stringify(got) === JSON.stringify(want);
  }],
  ['功能', '提醒带 item_name、expires_on，按 remind_on 再按 expires_on 排序', async () => {
    const rk = await reminders(S.a.token, S.hk);
    const exps = (rk || []).map((r) => r.expires_on);
    return !!rk && rk.length >= 3 && rk.every((r) => typeof r.id === 'string' && r.item_name?.startsWith('d') && typeof r.expires_on === 'string')
      && JSON.stringify(exps) === JSON.stringify([...exps].sort());
  }],
  ['健壮性', '同一天里重复触发（同一时刻、一小时后）不重复生成提醒', async () => {
    await trigger(T);
    await trigger(T + 3600 * 1000);
    const rk = await settledReminders(S.a.token, S.hk);
    const rp = await settledReminders(S.a.token, S.hp);
    return rk?.length === 3 && rp?.length === 3 && noDup(rk) && noDup(rp);
  }],
  ['健壮性', '定时任务 3 次同时触发也不重复生成提醒（3 轮）', async () => {
    for (let round = 0; round < 3; round++) {
      const at = T + (1800 + round * 60) * 1000;
      await Promise.all([reminders(S.a.token, S.hk), trigger(at), trigger(at), trigger(at + 1000)]);
    }
    const rk = await settledReminders(S.a.token, S.hk);
    const rp = await settledReminders(S.a.token, S.hp);
    return rk?.length === 3 && rp?.length === 3 && noDup(rk) && noDup(rp);
  }],
  ['功能', '到了家庭时区的第二天再触发，还在范围内的物品生成新一天的提醒', async () => {
    await trigger(T + 24 * 3600 * 1000);
    const rk = await settledReminders(S.a.token, S.hk);
    const rp = await settledReminders(S.a.token, S.hp);
    const k2 = (rk || []).filter((r) => r.remind_on === d(2)).map((r) => r.item_id).sort();
    const p2 = (rp || []).filter((r) => r.remind_on === d(1)).map((r) => r.item_id).sort();
    return rk?.length === 6 && rp?.length === 6
      && JSON.stringify(k2) === JSON.stringify([3, 4, 5].map((n) => S.sched.k[n]).sort())
      && JSON.stringify(p2) === JSON.stringify([1, 3, 4].map((n) => S.sched.p[n]).sort());
  }],
  ['鉴权与隔离', '提醒只给自己家的：别的家的提醒列表里没有这家的物品', async () => {
    await item(S.b.token, S.hb, { name: 'b 的酸奶', expires_on: addDays(localDate('Europe/Berlin', T), 1) });
    await trigger(T);
    const rb = await settledReminders(S.b.token, S.hb);
    const rk = await reminders(S.a.token, S.hk);
    const kIds = new Set(Object.values(S.sched.k));
    return !!rb && rb.length >= 1 && rb.every((r) => !kIds.has(r.item_id) && r.item_name === 'b 的酸奶') && rk?.every((r) => kIds.has(r.item_id));
  }],
  // ===== 成员变动 =====
  ['鉴权与隔离', '普通成员踢别人返回 403，owner 退出自己的家返回 400', async () => {
    const kick = await api('DELETE', `/v1/households/${S.ha}/members/${S.e.id}`, { token: S.c.token });
    const leave = await api('DELETE', `/v1/households/${S.ha}/members/${S.a.id}`, { token: S.a.token });
    return kick.status === 403 && leave.status === 400;
  }],
  ['功能', '成员退出返回 204，owner 踢人返回 204，成员列表跟着变', async () => {
    const leave = await api('DELETE', `/v1/households/${S.ha}/members/${S.c.id}`, { token: S.c.token });
    const kick = await api('DELETE', `/v1/households/${S.ha}/members/${S.e.id}`, { token: S.a.token });
    const m = await api('GET', `/v1/households/${S.ha}/members`, { token: S.a.token });
    return leave.status === 204 && kick.status === 204 && (m.data?.members || []).length === 1;
  }],
  ['鉴权与隔离', '退出和被踢的人再访问这个家（家庭、物品）都返回 404', async () => {
    const rs = await Promise.all([
      api('GET', `/v1/households/${S.ha}`, { token: S.c.token }),
      api('GET', `/v1/households/${S.ha}/items/${S.milk}`, { token: S.c.token }),
      api('GET', `/v1/households/${S.ha}`, { token: S.e.token }),
      api('POST', `/v1/households/${S.ha}/items`, { token: S.e.token, body: { name: '偷放' } }),
    ]);
    return rs.every((r) => r.status === 404);
  }],
  ['鉴权与隔离', '密码不以明文存库', async () => {
    const root = '.wrangler/state/v3/d1';
    if (!existsSync(root)) return false;
    const files = [];
    const walk = (p) => { for (const f of readdirSync(p)) { const q = join(p, f); if (statSync(q).isDirectory()) walk(q); else if (f.endsWith('.sqlite')) files.push(q); } };
    walk(root);
    if (!files.length) return false;
    let dump = '';
    for (const f of files) { try { dump += execSync(`sqlite3 "${f}" .dump`, { maxBuffer: 64 * 1024 * 1024 }).toString(); } catch {} }
    return dump.includes(`alice.${RUN}@example.com`) && !dump.includes(PW);
  }],
];

const up = await waitUp();
result.setup.serverUp = up;
for (const [block, name, fn] of cases) {
  let ok = false, err = '';
  if (up) { try { ok = !!(await fn()); } catch (e) { err = String(e.message || e).slice(0, 300); } }
  result.cases.push({ block, name, ok, err });
}
server.kill('SIGINT');
await sleep(1500);
try { server.kill('SIGKILL'); } catch {}
result.passed = result.cases.filter((c) => c.ok).length;
result.total = result.cases.length;
result.score = Math.round((result.passed / result.total) * 100);
result.blocks = {};
for (const c of result.cases) {
  const b = (result.blocks[c.block] ||= { passed: 0, total: 0 });
  b.total += 1;
  if (c.ok) b.passed += 1;
}
result.serverLogTail = log.slice(-1500);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`B2 ${result.passed}/${result.total} 分数 ${result.score}${up ? '' : '（服务没起来）'} ${JSON.stringify(result.blocks)}`);
process.exit(0);
