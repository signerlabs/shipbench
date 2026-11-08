/**
 * App Store Server Notifications V2 — 验证模块
 *
 * 使用 Apple 官方库 @apple/app-store-server-library 进行：
 * 1. JWS 签名验证 + 证书链校验（SignedDataVerifier）
 * 2. 通知 payload 解析（强类型）
 * 3. signedTransactionInfo / signedRenewalInfo 内层 JWS 验证与解析
 */

import {
  SignedDataVerifier,
  Environment,
  AppStoreServerAPIClient,
  APIException,
  Status,
} from '@apple/app-store-server-library';
import type {
  ResponseBodyV2DecodedPayload,
  JWSTransactionDecodedPayload,
  JWSRenewalInfoDecodedPayload,
} from '@apple/app-store-server-library';
import { getAppSecrets } from './secrets.js';
import { LIFETIME_PRODUCT_ID } from './iap-products.js';

// ============================================================
// 配置
// ============================================================

const BUNDLE_ID = 'com.example.shop-map-ios';

/** App Apple ID（数字），Sandbox 环境可省略 */
const APP_APPLE_ID = process.env['APP_APPLE_ID']
  ? parseInt(process.env['APP_APPLE_ID'], 10)
  : undefined;


// ============================================================
// Apple Root CA 证书（DER 格式 base64）
// 来源: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SignedDataVerifier 需要 DER 格式的 Buffer
// ============================================================

const APPLE_ROOT_CA_G3_DER_BASE64 = 'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

function loadAppleRootCertificates(): Buffer[] {
  return [Buffer.from(APPLE_ROOT_CA_G3_DER_BASE64, 'base64')];
}

// ============================================================
// SignedDataVerifier 单例（延迟初始化）
// ============================================================

let _productionVerifier: SignedDataVerifier | null = null;
let _sandboxVerifier: SignedDataVerifier | null = null;

function getProductionVerifier(): SignedDataVerifier {
  if (!_productionVerifier) {
    const rootCerts = loadAppleRootCertificates();
    _productionVerifier = new SignedDataVerifier(
      rootCerts,
      true,
      Environment.PRODUCTION,
      BUNDLE_ID,
      APP_APPLE_ID,
    );
    console.log(`[AppStore] Production Verifier 已初始化 | bundleId=${BUNDLE_ID} | appAppleId=${APP_APPLE_ID ?? '(未设置)'}`);
  }
  return _productionVerifier;
}

function getSandboxVerifier(): SignedDataVerifier {
  if (!_sandboxVerifier) {
    const rootCerts = loadAppleRootCertificates();
    _sandboxVerifier = new SignedDataVerifier(
      rootCerts,
      true,
      Environment.SANDBOX,
      BUNDLE_ID,
      undefined, // Sandbox 不需要 appAppleId
    );
    console.log('[AppStore] Sandbox Verifier 已初始化');
  }
  return _sandboxVerifier;
}

// ============================================================
// 导出类型（供 webhooks.ts 使用）
// ============================================================

/** 验证并解析后的完整通知 */
export interface DecodedNotification {
  /** 通知外层 payload（通知类型、UUID 等） */
  payload: ResponseBodyV2DecodedPayload;
  /** 解码后的交易信息 */
  transactionInfo: JWSTransactionDecodedPayload;
  /** 解码后的续订信息（可选） */
  renewalInfo?: JWSRenewalInfoDecodedPayload;
}

// ============================================================
// 主入口：验证并解析 Apple 通知
// ============================================================

/**
 * 验证并解析 App Store Server Notifications V2
 *
 * 三层验证：
 * 1. 外层 signedPayload → ResponseBodyV2DecodedPayload
 * 2. 内层 signedTransactionInfo → JWSTransactionDecodedPayload
 * 3. 内层 signedRenewalInfo → JWSRenewalInfoDecodedPayload（可选）
 *
 * @param signedPayload - Apple 发送的 JWS token
 * @returns 解析后的通知对象
 * @throws VerificationException 验证失败时抛出
 */
export async function verifyAndDecodeNotification(signedPayload: string): Promise<DecodedNotification> {
  // 先尝试 Production 验证，失败后尝试 Sandbox（兼容两种环境的通知）
  let verifier: SignedDataVerifier;
  let payload: ResponseBodyV2DecodedPayload;
  try {
    verifier = getProductionVerifier();
    payload = await verifier.verifyAndDecodeNotification(signedPayload);
  } catch {
    console.log('[AppStore] Production 验证失败，尝试 Sandbox 验证');
    verifier = getSandboxVerifier();
    payload = await verifier.verifyAndDecodeNotification(signedPayload);
  }

  if (!payload.data?.signedTransactionInfo) {
    throw new Error('通知缺少 signedTransactionInfo');
  }

  // 2. 验证内层 signedTransactionInfo JWS
  const transactionInfo = await verifier.verifyAndDecodeTransaction(
    payload.data.signedTransactionInfo,
  );

  // 3. 验证内层 signedRenewalInfo JWS（可选）
  let renewalInfo: JWSRenewalInfoDecodedPayload | undefined;
  if (payload.data.signedRenewalInfo) {
    renewalInfo = await verifier.verifyAndDecodeRenewalInfo(
      payload.data.signedRenewalInfo,
    );
  }

  return { payload, transactionInfo, renewalInfo };
}

// ============================================================
// App Store Server API — 订阅状态服务端反查（P0-2）
// ============================================================
//
// 供 POST /v1/auth/subscription 使用：客户端自声明 active 前，先用
// originalTransactionId 向 Apple 反查订阅真实状态，杜绝「手搓请求体秒变会员」。
//
// 密钥配置（Secrets Manager shopmap/app-secrets，需产品负责人在 App Store Connect
// 生成 In-App Purchase 类型 API 密钥后补齐以下字段）：
//   - APPSTORE_ISSUER_ID       — App Store Connect「密钥」页的 Issuer ID
//   - APPSTORE_KEY_ID          — In-App Purchase 密钥的 Key ID
//   - APPSTORE_IAP_PRIVATE_KEY — .p8 私钥文件完整内容（含 BEGIN/END 行）
// 未配置时 getIapClient 抛错，由调用方 fail-closed（503），绝不静默放行。

/**
 * AppStoreServerAPIClient 缓存（每个环境一个实例）。
 * 连同构建它的凭证一起缓存：getAppSecrets 已按 TTL 刷新（审查 HIGH 6），凭证轮换后
 * 这里比对到变化就重建客户端，不再出现「密钥换了、进程还拿旧客户端」的永久失效。
 */
const _iapClients = new Map<Environment, { client: AppStoreServerAPIClient; credentials: string }>();

async function getIapClient(env: Environment): Promise<AppStoreServerAPIClient> {
  const secrets = await getAppSecrets();
  const issuerId = secrets['APPSTORE_ISSUER_ID'];
  const keyId = secrets['APPSTORE_KEY_ID'];
  const rawPrivateKey = secrets['APPSTORE_IAP_PRIVATE_KEY'];
  if (!issuerId || !keyId || !rawPrivateKey) {
    throw new Error(
      'App Store IAP API 密钥未配置：请在 Secrets Manager shopmap/app-secrets 补齐 APPSTORE_ISSUER_ID / APPSTORE_KEY_ID / APPSTORE_IAP_PRIVATE_KEY',
    );
  }
  // 容错：Secrets Manager 控制台粘贴 .p8 时换行可能被存成字面 "\n"，统一还原
  const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
  const credentials = `${issuerId}\n${keyId}\n${privateKey}`;

  const cached = _iapClients.get(env);
  if (cached && cached.credentials === credentials) return cached.client;

  const client = new AppStoreServerAPIClient(privateKey, keyId, issuerId, BUNDLE_ID, env);
  _iapClients.set(env, { client, credentials });
  console.log(`[AppStore] IAP API Client ${cached ? '凭证变更后重建' : '已初始化'} | env=${env}`);
  return client;
}

/** 订阅反查结果 */
export interface SubscriptionVerifyResult {
  /** 交易真实存在、bundleId 匹配、且订阅当前有效 */
  verified: boolean;
  /** 命中的环境（Sandbox 命中也算验证通过，但调用方日志需标注） */
  environment: 'Production' | 'Sandbox';
  /** Apple 返回的产品 ID（以此为准，不信客户端） */
  productId?: string;
  /** Apple 返回的到期时间（ms，以此为准，不信客户端） */
  expiresDate?: number;
  /** verified=false 时的拒绝原因（排查用） */
  reason?: string;
}

/**
 * 向 Apple 反查 originalTransactionId 对应的订阅状态（Get All Subscription Statuses）。
 *
 * 环境处理：先查 Production，查无此单（HTTP 404）再回落 Sandbox（TestFlight/审核机可用）。
 *
 * 返回语义：
 *   - verified=true  → 交易存在 + 内层 JWS 验签通过（含 bundleId/环境校验）+ 订阅有效
 *                      （Status.ACTIVE 或 BILLING_GRACE_PERIOD，宽限期 Apple 语义保留权益）
 *   - verified=false → 明确的拒绝（查无此单 / 订阅非有效状态），调用方应 403
 *   - throw          → Apple API 不可用 / 密钥未配置 / 验签异常，调用方必须 fail-closed（503）
 */
export async function verifySubscriptionWithApple(
  originalTransactionId: string,
): Promise<SubscriptionVerifyResult> {
  const environments: { env: Environment; name: 'Production' | 'Sandbox' }[] = [
    { env: Environment.PRODUCTION, name: 'Production' },
    { env: Environment.SANDBOX, name: 'Sandbox' },
  ];

  for (const { env, name } of environments) {
    const client = await getIapClient(env);

    let statusResponse;
    try {
      statusResponse = await client.getAllSubscriptionStatuses(originalTransactionId);
    } catch (err) {
      // 404 = 该环境查无此交易 → 回落下一环境（Production 查不到 Sandbox 单是正常现象）
      if (err instanceof APIException && err.httpStatusCode === 404) {
        console.log(`[AppStore] 订阅反查 ${name} 环境查无此单，尝试下一环境 | otxid=${originalTransactionId}`);
        continue;
      }
      // 其他异常（401 密钥无效 / 429 限流 / 5xx / 网络）→ 冒泡给调用方 fail-closed
      throw err;
    }

    // 内层 JWS 用与环境匹配的 Verifier 验签（同时校验证书链 + bundleId + environment）
    const verifier = env === Environment.PRODUCTION ? getProductionVerifier() : getSandboxVerifier();

    for (const group of statusResponse.data ?? []) {
      for (const tx of group.lastTransactions ?? []) {
        if (tx.originalTransactionId !== originalTransactionId) continue;
        if (!tx.signedTransactionInfo) {
          return { verified: false, environment: name, reason: 'MISSING_SIGNED_TRANSACTION_INFO' };
        }

        const txInfo = await verifier.verifyAndDecodeTransaction(tx.signedTransactionInfo);
        const isEntitled = tx.status === Status.ACTIVE || tx.status === Status.BILLING_GRACE_PERIOD;

        if (!isEntitled) {
          return {
            verified: false,
            environment: name,
            productId: txInfo.productId,
            expiresDate: txInfo.expiresDate,
            reason: `SUBSCRIPTION_NOT_ACTIVE(status=${tx.status})`,
          };
        }

        return {
          verified: true,
          environment: name,
          productId: txInfo.productId,
          expiresDate: txInfo.expiresDate,
        };
      }
    }

    // 响应里没有该 originalTransactionId 的条目（例如传入的是续费 transactionId 而非 original）→ 拒绝
    return { verified: false, environment: name, reason: 'TRANSACTION_NOT_IN_RESPONSE' };
  }

  // Production 与 Sandbox 均查无此单
  return { verified: false, environment: 'Production', reason: 'TRANSACTION_NOT_FOUND' };
}

// ============================================================
// App Store Server API — 永久会员（非消耗型）服务端反查
// ============================================================

/** 永久会员反查结果 */
export interface LifetimeVerifyResult {
  /** 交易真实存在、bundleId 匹配、商品是永久会员、且未被撤销（无 revocationDate） */
  verified: boolean;
  environment: 'Production' | 'Sandbox';
  /** Apple 返回的商品 ID */
  productId?: string;
  /** Apple 返回的原始交易号（非消耗型与 transactionId 相同；TXID 映射以此为准，不信客户端） */
  originalTransactionId?: string;
  /** Apple 返回的交易号 */
  transactionId?: string;
  /** verified=false 时的拒绝原因（排查用） */
  reason?: string;
}

/**
 * 向 Apple 反查一笔永久会员交易（Get Transaction Info）。
 *
 * 为什么不用 verifySubscriptionWithApple：Get All Subscription Statuses 只覆盖自动续订订阅，
 * 非消耗型商品查不到。Get Transaction Info 接受任意 transactionId / originalTransactionId。
 *
 * 环境处理与订阅反查一致：先 Production，404 再回落 Sandbox。
 *
 * 返回语义：
 *   - verified=true  → 交易存在 + 内层 JWS 验签通过（含 bundleId/环境校验）+ 商品是永久会员 + 未撤销
 *   - verified=false → 明确的拒绝（查无此单 / 商品不符 / 已退款撤销），调用方应 403
 *   - throw          → Apple API 不可用 / 密钥未配置 / 验签异常，调用方必须 fail-closed（503）
 */
export async function verifyLifetimePurchaseWithApple(
  transactionId: string,
): Promise<LifetimeVerifyResult> {
  const environments: { env: Environment; name: 'Production' | 'Sandbox' }[] = [
    { env: Environment.PRODUCTION, name: 'Production' },
    { env: Environment.SANDBOX, name: 'Sandbox' },
  ];

  for (const { env, name } of environments) {
    const client = await getIapClient(env);

    let infoResponse;
    try {
      infoResponse = await client.getTransactionInfo(transactionId);
    } catch (err) {
      if (err instanceof APIException && err.httpStatusCode === 404) {
        console.log(`[AppStore] 永久会员反查 ${name} 环境查无此单，尝试下一环境 | txid=${transactionId}`);
        continue;
      }
      throw err;
    }

    if (!infoResponse.signedTransactionInfo) {
      return { verified: false, environment: name, reason: 'MISSING_SIGNED_TRANSACTION_INFO' };
    }

    const verifier = env === Environment.PRODUCTION ? getProductionVerifier() : getSandboxVerifier();
    const txInfo = await verifier.verifyAndDecodeTransaction(infoResponse.signedTransactionInfo);
    const base = {
      environment: name,
      productId: txInfo.productId,
      originalTransactionId: txInfo.originalTransactionId,
      transactionId: txInfo.transactionId,
    };

    if (txInfo.productId !== LIFETIME_PRODUCT_ID) {
      return { ...base, verified: false, reason: `PRODUCT_MISMATCH(${txInfo.productId})` };
    }
    if (txInfo.revocationDate) {
      return { ...base, verified: false, reason: `REVOKED(reason=${txInfo.revocationReason ?? 'unknown'})` };
    }
    return { ...base, verified: true };
  }

  return { verified: false, environment: 'Production', reason: 'TRANSACTION_NOT_FOUND' };
}
