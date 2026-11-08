/**
 * lib/apple-signin.ts 单元测试（2026-10-19，删号撤销 Sign in with Apple 授权）
 *
 * 覆盖：
 *   a) client_secret：ES256，header.kid=KWWK36TQ4W；iss=Team ID、aud=https://appleid.apple.com、
 *      sub=App Bundle ID（原生 Apple 登录的 code 属于 Bundle ID，不是 Cognito 的 Services ID）
 *   b) 流程：/auth/token 用 code 换 refresh_token → /auth/revoke 撤销
 *   c) 任一步失败返回 failed、绝不抛错（删号不能被 Apple 侧故障挡住）
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';

const mockGetSecretString = vi.fn();
vi.mock('../src/lib/secrets.js', () => ({
  getSecretString: (...a: unknown[]) => mockGetSecretString(...a),
}));

import {
  buildAppleClientSecret,
  revokeAppleAuthorization,
  SIWA_CLIENT_ID,
  APPLE_TEAM_ID,
  SIWA_KEY_ID,
} from '../src/lib/apple-signin.js';

let pem = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  pem = await jose.exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey as CryptoKey;
});

beforeEach(() => {
  mockGetSecretString.mockReset();
  mockGetSecretString.mockResolvedValue(pem);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client_secret', () => {
  it('ES256 + kid；iss/aud/sub 符合 Apple 规范，5 分钟有效', async () => {
    const now = 1_760_000_000;
    const jwt = await buildAppleClientSecret(pem, now);
    const header = jose.decodeProtectedHeader(jwt);
    expect(header).toEqual({ alg: 'ES256', kid: SIWA_KEY_ID });
    const { payload } = await jose.jwtVerify(jwt, publicKey, { currentDate: new Date(now * 1000) });
    expect(payload).toMatchObject({
      iss: APPLE_TEAM_ID,
      aud: 'https://appleid.apple.com',
      sub: SIWA_CLIENT_ID,
      iat: now,
      exp: now + 300,
    });
    expect(SIWA_CLIENT_ID).toBe('com.example.shop-map-ios');
    expect(APPLE_TEAM_ID).toBe('5GS4D3667R');
    expect(SIWA_KEY_ID).toBe('KWWK36TQ4W');
  });

  it('容错：Secret 里换行被存成字面 \\n 也能用', async () => {
    const escaped = pem.replace(/\n/g, '\\n');
    await expect(buildAppleClientSecret(escaped)).resolves.toMatch(/^ey/);
  });
});

describe('revokeAppleAuthorization', () => {
  function stubApple(handlers: { token: () => Response; revoke?: () => Response }) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/auth/token')) return handlers.token();
      if (u.endsWith('/auth/revoke')) return (handlers.revoke ?? (() => new Response('', { status: 200 })))();
      throw new Error(`unexpected ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('code 换 refresh_token 后撤销 → revoked；读的是 shopmap/apple-private-key', async () => {
    const fetchMock = stubApple({
      token: () => new Response(JSON.stringify({ refresh_token: 'rt-1', access_token: 'at-1' }), { status: 200 }),
    });
    expect(await revokeAppleAuthorization('code-1')).toBe('revoked');
    expect(mockGetSecretString).toHaveBeenCalledWith('shopmap/apple-private-key');

    const tokenForm = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(tokenForm.get('client_id')).toBe(SIWA_CLIENT_ID);
    expect(tokenForm.get('grant_type')).toBe('authorization_code');
    expect(tokenForm.get('code')).toBe('code-1');
    expect(tokenForm.get('client_secret')).toMatch(/^ey/);

    const revokeForm = new URLSearchParams(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(revokeForm.get('token')).toBe('rt-1');
    expect(revokeForm.get('token_type_hint')).toBe('refresh_token');
  });

  it('只拿到 access_token 时用它撤销', async () => {
    const fetchMock = stubApple({
      token: () => new Response(JSON.stringify({ access_token: 'at-only' }), { status: 200 }),
    });
    expect(await revokeAppleAuthorization('code-2')).toBe('revoked');
    const revokeForm = new URLSearchParams(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(revokeForm.get('token_type_hint')).toBe('access_token');
  });

  it('code 过期 / 已用（invalid_grant）→ failed，不再调 revoke', async () => {
    const fetchMock = stubApple({
      token: () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    expect(await revokeAppleAuthorization('stale')).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revoke 返回非 2xx → failed', async () => {
    stubApple({
      token: () => new Response(JSON.stringify({ refresh_token: 'rt' }), { status: 200 }),
      revoke: () => new Response('', { status: 500 }),
    });
    expect(await revokeAppleAuthorization('c')).toBe('failed');
  });

  it('读不到私钥（如 App Runner 角色还没有该 Secret 的权限）→ failed，不抛错', async () => {
    mockGetSecretString.mockRejectedValue(Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }));
    expect(await revokeAppleAuthorization('c')).toBe('failed');
  });

  it('网络异常 → failed，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await revokeAppleAuthorization('c')).toBe('failed');
  });
});
