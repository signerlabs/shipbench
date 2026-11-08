/**
 * 内购商品常量
 *
 * 永久会员（2026-10-19 新增）：非消耗型商品，一次买断。
 * 与自动续订订阅的差异：
 *   - 没有到期日，SUBSCRIPTION 行不写 expiresDate，改打 lifetime: true
 *   - Get All Subscription Statuses 查不到非消耗型商品，校验改用 Get Transaction Info
 *   - 不会「过期」：EXPIRATION 事件、客户端 expired 声明都不能把它降级；
 *     只有退款（RC CANCELLATION + CUSTOMER_SUPPORT / Apple REFUND、REVOKE）收回
 */

/** 永久会员商品 ID */
export const LIFETIME_PRODUCT_ID = 'com.example.shopmap.lifetime.68';

/** 是否为永久会员商品 */
export function isLifetimeProduct(productId: string | null | undefined): boolean {
  return productId === LIFETIME_PRODUCT_ID;
}
