// B2 参考实现：家庭物品与过期提醒（判分脚本的自检用，不给工具看）
// LAZY = true 时模拟「偷懒版」：时区按 UTC、定时任务用机器时间、邀请码先查后改、提醒先查后插、偏移量分页、不限请求体大小
const LAZY = false;

interface Env { DB: D1Database; TOKEN_SECRET?: string }

const enc = new TextEncoder();
const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n: number) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); };
const newId = () => crypto.randomUUID();
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hashPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

// ---------- 日期 ----------
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function localDate(tz: string, ms: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: LAZY ? 'UTC' : tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
const dayNum = (s: string) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
function addDays(s: string, n: number) { return new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10); }

// ---------- 请求体 ----------
async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') || '0');
  if (!LAZY && len > MAX_BODY) fail(413, 'body too large');
  const buf = await req.arrayBuffer();
  if (!LAZY && buf.byteLength > MAX_BODY) fail(413, 'body too large');
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(buf)); } catch { fail(400, 'invalid json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'body must be an object');
  return data as Record<string, unknown>;
}

// ---------- 鉴权 ----------
async function issueToken(env: Env, userId: string) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, Date.now()).run();
  return token;
}
async function authUser(env: Env, req: Request) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) fail(401, 'unauthorized');
  const row = await env.DB.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(await sha256(m![1])).first<{ id: string; email: string }>();
  if (!row) fail(401, 'unauthorized');
  return row!;
}

type Household = { id: string; name: string; timezone: string; owner_id: string; role: string };
async function membership(env: Env, userId: string, hid: string) {
  const row = await env.DB.prepare('SELECT h.id, h.name, h.timezone, h.owner_id, m.role FROM households h JOIN members m ON m.household_id = h.id WHERE h.id = ? AND m.user_id = ?').bind(hid, userId).first<Household>();
  if (!row) fail(404, 'not found');
  return row!;
}
const householdOut = (h: Household) => ({ id: h.id, name: h.name, timezone: h.timezone, role: h.role });

// ---------- 物品 ----------
type ItemRow = { seq: number; id: string; name: string; quantity: number; location_id: string | null; expires_on: string | null };
const itemOut = (r: ItemRow, today: string) => ({
  id: r.id, name: r.name, quantity: r.quantity, location_id: r.location_id, expires_on: r.expires_on,
  days_left: r.expires_on ? dayNum(r.expires_on) - dayNum(today) : null,
});

async function checkLocation(env: Env, hid: string, loc: unknown) {
  if (loc === null || loc === undefined) return null;
  if (typeof loc !== 'string') fail(400, 'location_id must be string');
  const row = await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND household_id = ?').bind(loc, hid).first();
  if (!row) fail(400, 'unknown location');
  return loc as string;
}
function checkQuantity(q: unknown) {
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 0) fail(400, 'quantity must be a non-negative integer');
  return q as number;
}
function checkExpires(e: unknown) {
  if (e === null) return null;
  if (!isValidDate(e)) fail(400, 'invalid date');
  return e as string;
}

function encodeCursor(o: unknown) { return btoa(JSON.stringify(o)); }
function decodeCursor(c: string): any {
  try { const o = JSON.parse(atob(c)); if (!o || typeof o !== 'object') throw 0; return o; } catch { fail(400, 'bad cursor'); }
}

async function listItems(env: Env, h: Household, url: URL) {
  const today = localDate(h.timezone, Date.now());
  const p = url.searchParams;
  let limit = 20;
  if (p.has('limit')) {
    const s = p.get('limit')!;
    if (!/^\d+$/.test(s)) fail(400, 'bad limit');
    limit = Number(s);
    if (limit < 1 || limit > 100) fail(400, 'bad limit');
  }
  let within: number | null = null;
  if (p.has('expiring_within_days')) {
    const s = p.get('expiring_within_days')!;
    if (!/^\d+$/.test(s) || Number(s) > 365) fail(400, 'bad expiring_within_days');
    within = Number(s);
  }
  let expired = false;
  if (p.has('expired')) {
    const s = p.get('expired');
    if (s !== 'true' && s !== 'false') fail(400, 'bad expired');
    expired = s === 'true';
  }
  const byDate = within !== null || expired;
  const where: string[] = ['household_id = ?'];
  const args: unknown[] = [h.id];
  if (within !== null) { where.push('expires_on IS NOT NULL AND expires_on >= ? AND expires_on <= ?'); args.push(today, addDays(today, within)); }
  if (expired) { where.push('expires_on IS NOT NULL AND expires_on < ?'); args.push(today); }
  const cursor = p.get('cursor');
  let offset = 0;
  if (cursor !== null) {
    const c = decodeCursor(cursor);
    if (LAZY) { offset = Number(c.o) || 0; }
    else if (byDate) {
      if (typeof c.e !== 'string' || typeof c.s !== 'number') fail(400, 'bad cursor');
      where.push('(expires_on > ? OR (expires_on = ? AND seq > ?))'); args.push(c.e, c.e, c.s);
    } else {
      if (typeof c.s !== 'number') fail(400, 'bad cursor');
      where.push('seq > ?'); args.push(c.s);
    }
  }
  const order = byDate ? 'expires_on ASC, seq ASC' : 'seq ASC';
  const sql = `SELECT seq, id, name, quantity, location_id, expires_on FROM items WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = (await env.DB.prepare(sql).bind(...args, limit + 1, offset).all<ItemRow>()).results;
  const page = rows.slice(0, limit);
  let next: string | null = null;
  if (rows.length > limit) {
    const last = page[page.length - 1];
    next = LAZY ? encodeCursor({ o: offset + limit }) : encodeCursor(byDate ? { e: last.expires_on, s: last.seq } : { s: last.seq });
  }
  return json({ items: page.map((r) => itemOut(r, today)), next_cursor: next });
}

// ---------- 定时任务 ----------
async function runReminders(env: Env, scheduledTime: number) {
  const now = LAZY ? Date.now() : scheduledTime;
  const households = (await env.DB.prepare('SELECT id, timezone FROM households').all<{ id: string; timezone: string }>()).results;
  for (const h of households) {
    const today = localDate(h.timezone, now);
    const items = (await env.DB.prepare('SELECT id, name, expires_on FROM items WHERE household_id = ? AND expires_on IS NOT NULL AND expires_on >= ? AND expires_on <= ?')
      .bind(h.id, today, addDays(today, 3)).all<{ id: string; name: string; expires_on: string }>()).results;
    if (!items.length) continue;
    if (LAZY) {
      for (const it of items) {
        const ex = await env.DB.prepare('SELECT id FROM reminders WHERE item_id = ? AND remind_on = ?').bind(it.id, today).first();
        if (!ex) await env.DB.prepare('INSERT INTO reminders (id, household_id, item_id, item_name, expires_on, remind_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(newId(), h.id, it.id, it.name, it.expires_on, today, Date.now()).run();
      }
    } else {
      await env.DB.batch(items.map((it) => env.DB.prepare('INSERT OR IGNORE INTO reminders (id, household_id, item_id, item_name, expires_on, remind_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(newId(), h.id, it.id, it.name, it.expires_on, today, Date.now())));
    }
  }
}

// ---------- 路由 ----------
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const seg = path.split('/').filter(Boolean); // v1, ...
  if (seg[0] !== 'v1') fail(404, 'not found');

  // 账号
  if (method === 'POST' && path === '/v1/auth/register') {
    const b = await readJson(req);
    if (typeof b.email !== 'string' || !b.email.includes('@') || typeof b.password !== 'string' || b.password.length < 8) fail(400, 'invalid email or password');
    const email = (b.email as string).trim().toLowerCase();
    if (LAZY) {
      // 偷懒版的常见写法：先查邮箱在不在，再算哈希、再插入（中间隔着十几毫秒的哈希）
      const ex = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (ex) fail(409, 'email taken');
    }
    const salt = randomHex(16);
    const id = newId();
    const pwHash = await hashPassword(b.password as string, salt);
    try {
      await env.DB.prepare('INSERT INTO users (id, email, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, email, pwHash, salt, Date.now()).run();
    } catch (e) {
      if (String(e).includes('UNIQUE')) fail(409, 'email taken');
      throw e;
    }
    return json({ user: { id, email }, token: await issueToken(env, id) }, 201);
  }
  if (method === 'POST' && path === '/v1/auth/login') {
    const b = await readJson(req);
    if (typeof b.email !== 'string' || typeof b.password !== 'string') fail(400, 'missing fields');
    const email = (b.email as string).trim().toLowerCase();
    const u = await env.DB.prepare('SELECT id, email, pw_hash, pw_salt FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; pw_hash: string; pw_salt: string }>();
    if (!u || (await hashPassword(b.password as string, u.pw_salt)) !== u.pw_hash) fail(401, 'bad credentials');
    return json({ user: { id: u!.id, email: u!.email }, token: await issueToken(env, u!.id) });
  }

  const me = await authUser(env, req);
  if (method === 'GET' && path === '/v1/me') return json({ id: me.id, email: me.email });

  // 邀请码
  if (seg[1] === 'invites' && seg.length === 4 && seg[3] === 'accept' && method === 'POST') {
    const code = decodeURIComponent(seg[2]);
    const inv = await env.DB.prepare('SELECT code, household_id, expires_at, used_by FROM invites WHERE code = ?').bind(code).first<{ code: string; household_id: string; expires_at: number; used_by: string | null }>();
    if (!inv) fail(404, 'no such invite');
    const already = await env.DB.prepare('SELECT 1 FROM members WHERE household_id = ? AND user_id = ?').bind(inv!.household_id, me.id).first();
    if (already) fail(409, 'already a member');
    const now = Date.now();
    if (LAZY) {
      if (inv!.used_by || inv!.expires_at <= now) fail(410, 'invite used or expired');
      await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').bind(me.id, now, code).run();
    } else {
      const r = await env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND expires_at > ?').bind(me.id, now, code, now).run();
      if (!r.meta.changes) fail(410, 'invite used or expired');
    }
    await env.DB.prepare('INSERT OR IGNORE INTO members (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(inv!.household_id, me.id, 'member', now).run();
    const h = await membership(env, me.id, inv!.household_id);
    return json({ household: householdOut(h) });
  }

  if (seg[1] !== 'households') fail(404, 'not found');

  if (seg.length === 2) {
    if (method === 'POST') {
      const b = await readJson(req);
      if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'name required');
      if (!isValidTimeZone(b.timezone)) fail(400, 'invalid timezone');
      const id = newId();
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO households (id, name, timezone, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, (b.name as string).trim(), b.timezone, me.id, now),
        env.DB.prepare('INSERT INTO members (household_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(id, me.id, 'owner', now),
      ]);
      return json({ id, name: (b.name as string).trim(), timezone: b.timezone, role: 'owner' }, 201);
    }
    if (method === 'GET') {
      const rows = (await env.DB.prepare('SELECT h.id, h.name, h.timezone, h.owner_id, m.role FROM households h JOIN members m ON m.household_id = h.id WHERE m.user_id = ? ORDER BY h.created_at').bind(me.id).all<Household>()).results;
      return json({ households: rows.map(householdOut) });
    }
    fail(404, 'not found');
  }

  const hid = decodeURIComponent(seg[2]);
  const h = await membership(env, me.id, hid);
  const sub = seg[3];

  if (seg.length === 3) {
    if (method === 'GET') return json(householdOut(h));
    fail(404, 'not found');
  }

  if (sub === 'invites' && seg.length === 4 && method === 'POST') {
    if (h.role !== 'owner') fail(403, 'only owner');
    const code = randomHex(8);
    const expires = Date.now() + 24 * 3600 * 1000;
    await env.DB.prepare('INSERT INTO invites (code, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)').bind(code, hid, me.id, expires).run();
    return json({ code, expires_at_ms: expires }, 201);
  }

  if (sub === 'members') {
    if (seg.length === 4 && method === 'GET') {
      const rows = (await env.DB.prepare('SELECT m.user_id, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.created_at').bind(hid).all()).results;
      return json({ members: rows });
    }
    if (seg.length === 5 && method === 'DELETE') {
      const target = decodeURIComponent(seg[4]);
      if (target === me.id) {
        if (h.role === 'owner') fail(400, 'owner cannot leave');
      } else if (h.role !== 'owner') fail(403, 'only owner');
      const r = await env.DB.prepare('DELETE FROM members WHERE household_id = ? AND user_id = ?').bind(hid, target).run();
      if (!r.meta.changes) fail(404, 'not a member');
      return noContent();
    }
    fail(404, 'not found');
  }

  if (sub === 'locations') {
    if (seg.length === 4 && method === 'POST') {
      const b = await readJson(req);
      if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'name required');
      let depth = 1;
      const parent = b.parent_id ?? null;
      if (parent !== null) {
        if (typeof parent !== 'string') fail(400, 'bad parent_id');
        const p = await env.DB.prepare('SELECT depth FROM locations WHERE id = ? AND household_id = ?').bind(parent, hid).first<{ depth: number }>();
        if (!p) fail(400, 'unknown parent');
        depth = p!.depth + 1;
        if (depth > 3) fail(400, 'too deep');
      }
      const id = newId();
      await env.DB.prepare('INSERT INTO locations (id, household_id, parent_id, name, depth) VALUES (?, ?, ?, ?, ?)').bind(id, hid, parent, (b.name as string).trim(), depth).run();
      return json({ id, name: (b.name as string).trim(), parent_id: parent }, 201);
    }
    if (seg.length === 4 && method === 'GET') {
      const rows = (await env.DB.prepare('SELECT id, name, parent_id FROM locations WHERE household_id = ? ORDER BY seq').bind(hid).all<{ id: string; name: string; parent_id: string | null }>()).results;
      const nodes = new Map(rows.map((r) => [r.id, { ...r, children: [] as unknown[] }]));
      const roots: unknown[] = [];
      for (const r of rows) {
        const n = nodes.get(r.id)!;
        if (r.parent_id && nodes.has(r.parent_id)) nodes.get(r.parent_id)!.children.push(n); else roots.push(n);
      }
      return json({ locations: roots });
    }
    if (seg.length === 5 && method === 'DELETE') {
      const lid = decodeURIComponent(seg[4]);
      const loc = await env.DB.prepare('SELECT id FROM locations WHERE id = ? AND household_id = ?').bind(lid, hid).first();
      if (!loc) fail(404, 'not found');
      const child = await env.DB.prepare('SELECT 1 FROM locations WHERE parent_id = ? LIMIT 1').bind(lid).first();
      const item = await env.DB.prepare('SELECT 1 FROM items WHERE location_id = ? LIMIT 1').bind(lid).first();
      if (child || item) fail(409, 'location not empty');
      await env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(lid).run();
      return noContent();
    }
    fail(404, 'not found');
  }

  if (sub === 'items') {
    const today = localDate(h.timezone, Date.now());
    if (seg.length === 4 && method === 'POST') {
      const b = await readJson(req);
      if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'name required');
      const quantity = b.quantity === undefined ? 1 : checkQuantity(b.quantity);
      const location = await checkLocation(env, hid, b.location_id);
      const expires = b.expires_on === undefined ? null : checkExpires(b.expires_on);
      const id = newId();
      await env.DB.prepare('INSERT INTO items (id, household_id, name, quantity, location_id, expires_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, hid, (b.name as string).trim(), quantity, location, expires, Date.now()).run();
      return json(itemOut({ seq: 0, id, name: (b.name as string).trim(), quantity, location_id: location, expires_on: expires }, today), 201);
    }
    if (seg.length === 4 && method === 'GET') return listItems(env, h, url);
    if (seg.length === 5) {
      const iid = decodeURIComponent(seg[4]);
      const row = await env.DB.prepare('SELECT seq, id, name, quantity, location_id, expires_on FROM items WHERE id = ? AND household_id = ?').bind(iid, hid).first<ItemRow>();
      if (!row) fail(404, 'not found');
      if (method === 'GET') return json(itemOut(row!, today));
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(iid).run();
        return noContent();
      }
      if (method === 'PATCH') {
        const b = await readJson(req);
        const next = { ...row! };
        if ('name' in b) { if (typeof b.name !== 'string' || !b.name.trim()) fail(400, 'name required'); next.name = (b.name as string).trim(); }
        if ('quantity' in b) next.quantity = checkQuantity(b.quantity);
        if ('location_id' in b) next.location_id = await checkLocation(env, hid, b.location_id);
        if ('expires_on' in b) next.expires_on = checkExpires(b.expires_on);
        await env.DB.prepare('UPDATE items SET name = ?, quantity = ?, location_id = ?, expires_on = ? WHERE id = ?').bind(next.name, next.quantity, next.location_id, next.expires_on, iid).run();
        return json(itemOut(next, today));
      }
    }
    fail(404, 'not found');
  }

  if (sub === 'reminders' && seg.length === 4 && method === 'GET') {
    const rows = (await env.DB.prepare('SELECT id, item_id, item_name, expires_on, remind_on FROM reminders WHERE household_id = ? ORDER BY remind_on, expires_on').bind(hid).all()).results;
    return json({ reminders: rows });
  }

  fail(404, 'not found');
  return json({});
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'internal error' }, 500);
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env, event.scheduledTime));
  },
};
