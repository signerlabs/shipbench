interface Env { DB: D1Database; WEBHOOK_SECRET: string; API_TOKEN: string }
const STATUS: Record<string, [string, boolean] | undefined> = {
  INITIAL_PURCHASE: ['active', true], RENEWAL: ['active', true], UNCANCELLATION: ['active', true],
  CANCELLATION: ['cancelled', false], EXPIRATION: ['expired', false], REFUND: ['refunded', false],
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get('authorization') ?? '';
    if (req.method === 'POST' && url.pathname === '/v1/webhooks/subscription') {
      if (auth !== `Bearer ${env.WEBHOOK_SECRET}`) return json({ error: 'unauthorized' }, 401);
      let body: any; try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const e = body?.event;
      if (!e || !e.id || !e.type || !e.app_user_id || typeof e.event_timestamp_ms !== 'number') return json({ error: 'bad event' }, 400);
      const ins = await env.DB.prepare('INSERT OR IGNORE INTO events (id) VALUES (?)').bind(e.id).run();
      if (!ins.meta.changes) return json({ ok: true });
      const m = STATUS[e.type];
      if (!m) return json({ ok: true });
      await env.DB.prepare(`INSERT INTO subs (user_id, status, product_id, expires_at_ms, will_renew, last_event_ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, product_id = excluded.product_id, expires_at_ms = excluded.expires_at_ms,
        will_renew = excluded.will_renew, last_event_ts = excluded.last_event_ts WHERE excluded.last_event_ts > subs.last_event_ts`)
        .bind(e.app_user_id, m[0], e.product_id ?? null, e.expiration_at_ms ?? null, m[1] ? 1 : 0, e.event_timestamp_ms).run();
      return json({ ok: true });
    }
    const mm = url.pathname.match(/^\/v1\/users\/([^/]+)\/subscription$/);
    if (req.method === 'GET' && mm) {
      if (auth !== `Bearer ${env.API_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      const user = decodeURIComponent(mm[1]);
      const r: any = await env.DB.prepare('SELECT * FROM subs WHERE user_id = ?').bind(user).first();
      if (!r) return json({ app_user_id: user, status: 'none', active: false, product_id: null, expires_at_ms: null, will_renew: false });
      const active = (r.status === 'active' || r.status === 'cancelled') && r.expires_at_ms > Date.now();
      return json({ app_user_id: user, status: r.status, active, product_id: r.product_id, expires_at_ms: r.expires_at_ms, will_renew: !!r.will_renew });
    }
    return json({ error: 'not found' }, 404);
  },
};
