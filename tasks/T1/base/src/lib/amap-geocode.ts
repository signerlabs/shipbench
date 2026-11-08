/**
 * 高德 Web 服务的公共部分
 *
 * 2026-10-20 起认店定位改由认店代理（shop-agent.ts）用高德官方 MCP 工具完成，旧的「四道闸」补坐标决策流
 * （resolveAmapCoordinate：同名择店、位置线索锚点、地址点顶替、名称校验、城市回环兜底）连同候选查找一并删除。
 * 这里只留：
 *  - deriveCityLayers：高德 pname/cityname/adname → 三层城市（全库分区键口径）
 *  - cityLoopbackPass：城市名宽松比对（推荐者排行、推荐类型判定在用）
 *  - amapFetchJson：Web 服务 GET 公共通道（重试、超时、可走国内转发）
 *  - regeoAmap：坐标 → 三层城市（前端定位刷新、存量迁移在用）
 */

/**
 * 城市三层归属（2026-07-07 城市分层重构，命名与前后端/DB/API 统一为 CLPlacemark 口径）
 * - administrativeArea：省（高德 pname，如「吉林省」）
 * - locality：地级（高德 cityname，如「延边朝鲜族自治州」/「北京市」）——分区键 / 筛选 / feed / 榜单一律用这层
 * - subLocality：区县 / 县级市（高德 adname 原始值，如「延吉市」/「东城区」）——展示精度规则交前端
 */
export interface CityLayers {
  administrativeArea: string;
  locality: string;
  subLocality: string;
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 直辖市 / 港澳特别行政区：regeo 的 addressComponent.city 返回空数组，
 * 但它们「地级 = 省本身」，locality 落省名是对的（北京市/上海市…）。普通省/自治区
 * 若 city 空，则是省直辖县级市/兵团市（潜江/文昌/万宁/石河子），应按地级处理、
 * 用自身县级名（subLocality），绝不落省名（否则分区键污染成 CITY#湖北省）。
 */
const PROVINCE_LEVEL_MUNICIPALITIES = new Set([
  '北京市', '上海市', '天津市', '重庆市', '香港特别行政区', '澳门特别行政区',
]);

/**
 * 从高德的 pname/cityname/adname（place/text）或 province/city/district（regeo）
 * 归并出三层 city。地级 city 非空 → 直接用（正常分支）；city 空数组时按 province 类型分流：
 * 直辖市/港澳落省名，普通省/自治区落县级名（subLocality）。
 */
export function deriveCityLayers(pname?: unknown, cityname?: unknown, adname?: unknown): CityLayers {
  const administrativeArea = trimStr(pname);
  const subLocality = trimStr(adname);                       // 区县/县级市原始值（东城区/延吉市）
  const cityLevel = trimStr(cityname);                       // 地级（regeo/place 的 city/cityname）
  let locality: string;
  if (cityLevel) {
    // 正常分支：高德返回了地级 city，直接用
    locality = cityLevel;
  } else if (PROVINCE_LEVEL_MUNICIPALITIES.has(administrativeArea)) {
    // 直辖市/港澳：city 空数组 → 地级即省本身
    locality = administrativeArea;
  } else {
    // 普通省/自治区 + city 空 = 省直辖县级市/兵团市：按地级处理用自身县级名；
    // 极端兜底 district 也空则回落省名（防崩，实测这类 district 均非空）
    locality = subLocality || administrativeArea;
  }
  return { administrativeArea, locality, subLocality };
}

/**
 * 城市名宽松归约 key（回环校验用）：去尾部行政区后缀（含境外 都/府/道）+ 去民族/自治词。
 * 延吉市→延吉、延边朝鲜族自治州→延边、东京都→东京。
 */
function looseCityKey(x: string): string {
  return (x || '').trim()
    .replace(/特别行政区$/, '')
    .replace(/(省|市|区|县|州|盟|地区|都|府|道)$/, '')
    .replace(/(朝鲜族|回族|壮族|维吾尔|藏族|蒙古族|苗族|彝族|哈尼族|傣族|白族|土家族|布依族|侗族|傈僳族|柯尔克孜|哈萨克|景颇族|羌族|自治)/g, '');
}

/**
 * 城市名宽松比对：意图 city ∈ {locality(地级), subLocality(区县)} 宽松互含
 * （推荐者排行、推荐类型判定用；原为补坐标的城市回环闸，2026-10-20 补坐标规则删除后保留通用部分）
 */
export function cityLoopbackPass(intentCity: string, locality?: string, subLocality?: string): boolean {
  const ik = looseCityKey(intentCity);
  if (!ik) return false;
  return [locality, subLocality].some((c) => {
    const ck = looseCityKey(c || '');
    return !!ck && (ck.includes(ik) || ik.includes(ck));
  });
}

/**
 * 国内转发（2026-10-20）：从新加坡直连 restapi.amap.com 常被阿里 WAF 限流，导入函数改走阿里云函数计算上的
 * 转发（infra/amap-proxy，只放行 place/text、place/around、place/detail、geocode/geo、geocode/regeo）。
 * 由调用方在启动时设置（parse-processor 读 AMAP_PROXY_URL）；不设就直连。
 */
let amapProxyBase: string | null = null;
export function useAmapProxy(base: string | null | undefined): void {
  amapProxyBase = base ? base.replace(/\/+$/, '') : null;
}

/**
 * 高德 HTTP GET 公共通道（2026-07-13 · Lambda 出口 IP 段被阿里 WAF 风控实战教训）：
 *  - 带常规浏览器 UA —— 裸 fetch 无 UA 是 WAF 判爬虫的显著特征；
 *  - 每次最多等 10s —— WAF 限流表现为响应极慢而非直接拒绝；
 *  - 最多试 3 次，间隔 1s、3s。
 */
const AMAP_RETRY_DELAYS_MS = [1000, 3000];

export async function amapFetchJson<T>(url: string): Promise<T> {
  const target = amapProxyBase ? url.replace(/^https:\/\/restapi\.amap\.com/, amapProxyBase) : url;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AMAP_RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const resp = await fetch(target, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) throw new Error(`高德 HTTP ${resp.status}`);
      return await resp.json() as T;
    } catch (err) {
      lastErr = err;
      const delay = AMAP_RETRY_DELAYS_MS[attempt - 1];
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** regeo 结果缓存（~110m 网格 key）：同/邻近坐标不重复调高德（App Runner 长驻进程复用）。
 *  FIFO 封顶 REGEO_CACHE_MAX 防长驻进程内存无界爬升。 */
const REGEO_CACHE_MAX = 5000;
const regeoCache = new Map<string, CityLayers>();
function regeoGridKey(longitude: number, latitude: number): string {
  return `${longitude.toFixed(3)},${latitude.toFixed(3)}`; // 3 位小数 ≈ 110m 网格
}

/**
 * 高德逆地理编码 regeo（坐标 → 三层 city），带 ~100m 网格缓存
 *
 * 供前端定位刷新的 regeo 接口、存量迁移复用。
 * 返回 administrativeArea/locality/subLocality 三层。直辖市 regeo 的 city 返回空数组 []
 * → deriveCityLayers 内已用省兜底 locality。异常（配额/超时）抛错，调用方降级。
 */
export async function regeoAmap(
  amapKey: string,
  longitude: number,
  latitude: number,
): Promise<CityLayers | null> {
  const gk = regeoGridKey(longitude, latitude);
  const cached = regeoCache.get(gk);
  if (cached) return cached;

  const params = new URLSearchParams({
    key: amapKey,
    location: `${longitude},${latitude}`,
    extensions: 'base',
  });
  const data = await amapFetchJson<{ infocode?: string; regeocode?: { addressComponent?: Record<string, unknown> } }>(
    `https://restapi.amap.com/v3/geocode/regeo?${params}`,
  );
  if (data.infocode !== '10000') throw new Error(`高德 regeo infocode=${data.infocode}`);
  const ac = data.regeocode?.addressComponent;
  if (!ac) return null;
  const layers = deriveCityLayers(ac['province'], ac['city'], ac['district']);
  if (!layers.locality) return null;
  // FIFO 封顶：超上限删最旧插入项，防内存无界爬升
  if (regeoCache.size >= REGEO_CACHE_MAX) {
    const oldest = regeoCache.keys().next().value;
    if (oldest !== undefined) regeoCache.delete(oldest);
  }
  regeoCache.set(gk, layers);
  return layers;
}
