/**
 * lib/appstore.ts：永久会员反查 + IAP 客户端随凭证轮换重建（2026-10-19）
 *
 * 覆盖：
 *   a) verifyLifetimePurchaseWithApple 走 Get Transaction Info（订阅接口查不到非消耗型）：
 *      商品 ID 对、无 revocationDate 才 verified；Production 404 回落 Sandbox；其它异常抛出（调用方 503）
 *   b) 审查 HIGH 6 配套：IAP API 客户端不再永久缓存，Secrets 里的密钥换了就重建
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getTransactionInfo: vi.fn(),
  decode: vi.fn(),
  clientCtor: vi.fn(),
  secrets: vi.fn(),
}));

vi.mock('@apple/app-store-server-library', () => {
  class APIException extends Error {
    constructor(public httpStatusCode: number) { super(`api ${httpStatusCode}`); }
  }
  return {
    Environment: { PRODUCTION: 'Production', SANDBOX: 'Sandbox' },
    Status: { ACTIVE: 1, BILLING_GRACE_PERIOD: 4 },
    APIException,
    AppStoreServerAPIClient: class {
      constructor(...args: unknown[]) { h.clientCtor(...args); this.env = args[4] as string; }
      env: string;
      getTransactionInfo(id: string) { return h.getTransactionInfo(this.env, id); }
    },
    SignedDataVerifier: class {
      verifyAndDecodeTransaction(jws: string) { return h.decode(jws); }
    },
  };
});
vi.mock('../src/lib/secrets.js', () => ({ getAppSecrets: () => h.secrets() }));

import { APIException } from '@apple/app-store-server-library';
import { verifyLifetimePurchaseWithApple } from '../src/lib/appstore.js';
import { LIFETIME_PRODUCT_ID } from '../src/lib/iap-products.js';

const CREDS = { APPSTORE_ISSUER_ID: 'iss', APPSTORE_KEY_ID: 'kid', APPSTORE_IAP_PRIVATE_KEY: 'pk-1' };

beforeEach(() => {
  h.getTransactionInfo.mockReset();
  h.decode.mockReset();
  h.secrets.mockReset();
  h.secrets.mockResolvedValue(CREDS);
});

describe('verifyLifetimePurchaseWithApple', () => {
  it('商品对、未撤销 → verified，返回 Apple 的原始交易号', async () => {
    h.getTransactionInfo.mockResolvedValue({ signedTransactionInfo: 'jws' });
    h.decode.mockResolvedValue({ productId: LIFETIME_PRODUCT_ID, originalTransactionId: 'otx', transactionId: 'tx' });
    const r = await verifyLifetimePurchaseWithApple('tx');
    expect(r).toMatchObject({ verified: true, environment: 'Production', originalTransactionId: 'otx', transactionId: 'tx' });
  });

  it('商品不是永久会员（拿订阅交易号冒充）→ 拒绝', async () => {
    h.getTransactionInfo.mockResolvedValue({ signedTransactionInfo: 'jws' });
    h.decode.mockResolvedValue({ productId: 'monthly', originalTransactionId: 'otx' });
    const r = await verifyLifetimePurchaseWithApple('tx');
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('PRODUCT_MISMATCH');
  });

  it('已退款（有 revocationDate）→ 拒绝', async () => {
    h.getTransactionInfo.mockResolvedValue({ signedTransactionInfo: 'jws' });
    h.decode.mockResolvedValue({ productId: LIFETIME_PRODUCT_ID, revocationDate: 1_700_000_000_000, revocationReason: 0 });
    const r = await verifyLifetimePurchaseWithApple('tx');
    expect(r.verified).toBe(false);
    expect(r.reason).toContain('REVOKED');
  });

  it('Production 查无此单（404）→ 回落 Sandbox（TestFlight / 审核机）', async () => {
    h.getTransactionInfo.mockImplementation(async (env: string) => {
      if (env === 'Production') throw new (APIException as unknown as new (s: number) => Error)(404);
      return { signedTransactionInfo: 'jws' };
    });
    h.decode.mockResolvedValue({ productId: LIFETIME_PRODUCT_ID, originalTransactionId: 'otx' });
    const r = await verifyLifetimePurchaseWithApple('tx');
    expect(r).toMatchObject({ verified: true, environment: 'Sandbox' });
  });

  it('两个环境都查无此单 → TRANSACTION_NOT_FOUND', async () => {
    h.getTransactionInfo.mockRejectedValue(new (APIException as unknown as new (s: number) => Error)(404));
    const r = await verifyLifetimePurchaseWithApple('tx');
    expect(r).toMatchObject({ verified: false, reason: 'TRANSACTION_NOT_FOUND' });
  });

  it('其它异常（401 / 5xx / 网络）→ 抛出，由调用方 fail-closed', async () => {
    h.getTransactionInfo.mockRejectedValue(new (APIException as unknown as new (s: number) => Error)(500));
    await expect(verifyLifetimePurchaseWithApple('tx')).rejects.toThrow();
  });
});

describe('IAP 客户端随凭证轮换重建', () => {
  it('凭证不变复用客户端；私钥换了就重建', async () => {
    h.getTransactionInfo.mockResolvedValue({ signedTransactionInfo: 'jws' });
    h.decode.mockResolvedValue({ productId: LIFETIME_PRODUCT_ID });
    h.clientCtor.mockClear();

    await verifyLifetimePurchaseWithApple('tx');
    await verifyLifetimePurchaseWithApple('tx');
    const builtBefore = h.clientCtor.mock.calls.length;
    // 两次调用凭证相同：最多建一次（前面用例可能已建好并缓存，则为 0）
    expect(builtBefore).toBeLessThanOrEqual(1);

    h.secrets.mockResolvedValue({ ...CREDS, APPSTORE_IAP_PRIVATE_KEY: 'pk-2' });
    await verifyLifetimePurchaseWithApple('tx');
    expect(h.clientCtor.mock.calls.length).toBe(builtBefore + 1);
    expect(h.clientCtor.mock.calls.at(-1)?.[0]).toBe('pk-2');
  });
});
