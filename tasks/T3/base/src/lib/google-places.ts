/**
 * Google 地图（2026-10-21）：台湾和中国以外的店用它定位，做法照另一个项目的 places.ts
 *
 *   - 中国大陆、港澳走高德（amap-geocode.ts），台湾和其他国家走这里（产品负责人 10/21 定）
 *   - Places Text Search (New) 搜店：只收餐饮类结果（另一个项目的实测教训：区域名会混进结果）；Google 只标了泛类别的不排除（台湾奶茶店常这样）
 *   - Geocoding 反查城市：按 colloquial_area+locality → locality → postal_town → admin_area_1 四级挑，
 *     东京 23 区在 Google 里各算一个市，统一归成 Tokyo（小店按城市分首页，一座城只能有一种写法）
 *   - 语言：境外的店名、地址、城市一律英文（en）；台湾用中文（zh-CN）——产品负责人 10/21 定，不做双语、不翻译
 *   - 坐标是 WGS-84（境外不做 GCJ-02 偏移），App 直接用
 *
 * 只依赖传入的 API Key 与 fetch，不读 process.env：解析 Lambda、重跑预览、后台脚本共用
 */

/** 餐饮类 types（Places New 的 primaryType / types）；命中任一即算餐饮店 */
const FNB_TYPES = new Set([
  'restaurant', 'food', 'cafe', 'coffee_shop', 'bakery', 'bar', 'pub', 'wine_bar', 'night_club',
  'meal_takeaway', 'meal_delivery', 'dessert_shop', 'dessert_restaurant', 'ice_cream_shop',
  'hawker_centre', 'food_court', 'tea_house', 'juice_shop', 'market', 'confectionery', 'deli',
]);
/** 拒收：行政区、交通站等实体（优先级高于餐饮白名单） */
const REJECT_TYPES = new Set([
  'locality', 'sublocality', 'sublocality_level_1', 'neighborhood', 'administrative_area_level_1',
  'administrative_area_level_2', 'country', 'postal_code', 'transit_station', 'subway_station',
  'train_station', 'bus_station', 'route', 'lodging', 'hotel',
]);

/** 泛类别：Google 没给具体类别时只有这几个（台湾不少奶茶店就是这样，10/21 鬍子茶、MATEAS） */
const GENERIC_TYPES = new Set(['point_of_interest', 'establishment', 'store', 'service']);

export function isFoodPlace(types: string[]): boolean {
  if (types.some((t) => REJECT_TYPES.has(t))) return false;
  if (types.some((t) => FNB_TYPES.has(t) || t.endsWith('_restaurant'))) return true;
  // 只有泛类别的不排除（是不是吃饭的地方由模型按店名、地址认），有具体非餐饮类别的才排除
  return types.length > 0 && types.every((t) => GENERIC_TYPES.has(t));
}

export interface GooglePlace {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  types: string[];
  /** OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY */
  status: string | null;
  /** 国家代码（ISO 3166-1 alpha-2，来自 addressComponents） */
  countryCode: string | null;
}

/** 台湾用中文，其余境外用英文 */
export function languageForCountry(countryCode: string | null | undefined): 'en' | 'zh-CN' {
  return countryCode === 'TW' ? 'zh-CN' : 'en';
}

interface RawPlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  businessStatus?: string;
  addressComponents?: Array<{ shortText?: string; types?: string[] }>;
}

const FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'types', 'businessStatus', 'addressComponents'];

function toPlace(p: RawPlace): GooglePlace | null {
  const lat = p.location?.latitude;
  const lng = p.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    placeId: p.id,
    name: p.displayName?.text ?? '',
    address: p.formattedAddress ?? null,
    lat,
    lng,
    types: p.types ?? [],
    status: p.businessStatus ?? null,
    countryCode: p.addressComponents?.find((c) => c.types?.includes('country'))?.shortText ?? null,
  };
}

/**
 * 文本搜店：返回所有餐饮类结果（同名连锁要靠位置线索挑，不只取第一条）
 * bias 给了就往那附近偏（抖音地点、视频里的城市中心）
 */
export async function searchPlaces(
  apiKey: string,
  query: string,
  opts: { language?: 'en' | 'zh-CN'; bias?: { lat: number; lng: number; radiusM?: number }; max?: number } = {},
): Promise<GooglePlace[]> {
  const body: Record<string, unknown> = { textQuery: query, maxResultCount: opts.max ?? 5, languageCode: opts.language ?? 'en' };
  if (opts.bias) {
    body.locationBias = { circle: { center: { latitude: opts.bias.lat, longitude: opts.bias.lng }, radius: opts.bias.radiusM ?? 5000 } };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS.map((f) => `places.${f}`).join(',') },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google Places searchText ${res.status}`);
  const j = (await res.json()) as { places?: RawPlace[] };
  return (j.places ?? []).map(toPlace).filter((p): p is GooglePlace => !!p && isFoodPlace(p.types));
}

/** 按 Google 店铺编号取详情（换语言取名字、地址也用它） */
export async function placeDetails(apiKey: string, placeId: string, language: 'en' | 'zh-CN' = 'en'): Promise<GooglePlace | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${language}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS.join(',') },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Places details ${res.status}`);
  return toPlace((await res.json()) as RawPlace);
}

interface GeocodeResult {
  place_id: string;
  types: string[];
  address_components: Array<{ long_name: string; short_name: string; types: string[] }>;
  formatted_address: string;
}

export interface GoogleCity {
  /** 城市名：境外英文（Tokyo、Chiang Mai），台湾中文（台北市） */
  city: string;
  cityPlaceId: string;
  countryCode: string | null;
  /** 一级行政区（州、省、都道府县；台湾的县市本身），对应高德三层里的省 */
  administrativeArea: string;
}

/** 坐标 → 城市（另一个项目的四级挑法 + 东京 23 区归 Tokyo） */
export async function resolveCity(apiKey: string, lat: number, lng: number, language: 'en' | 'zh-CN' = 'en'): Promise<GoogleCity | null> {
  const qs = new URLSearchParams({
    latlng: `${lat},${lng}`,
    result_type: 'locality|postal_town|administrative_area_level_1|colloquial_area',
    language,
    key: apiKey,
  });
  const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`, { signal: AbortSignal.timeout(10_000) });
  const j = (await res.json()) as { status: string; results?: GeocodeResult[] };
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') throw new Error(`Google geocode ${j.status}`);
  const results = j.results ?? [];
  const pick = results.find((r) => r.types.includes('colloquial_area') && r.types.includes('locality'))
    ?? results.find((r) => r.types.includes('locality'))
    ?? results.find((r) => r.types.includes('postal_town'))
    ?? results.find((r) => r.types.includes('administrative_area_level_1'));
  if (!pick) return null;
  const comp = (r: GeocodeResult, t: string) => r.address_components.find((c) => c.types.includes(t));
  const countryCode = comp(pick, 'country')?.short_name ?? null;
  const admin1 = results.find((r) => r.types.includes('administrative_area_level_1'));
  const administrativeArea = comp(pick, 'administrative_area_level_1')?.long_name ?? admin1?.address_components[0]?.long_name ?? '';
  // 东京都下的区、市（千代田区 Chiyoda City 等）统一归东京
  if (countryCode === 'JP' && admin1 && /^(Tokyo|东京都|東京都)$/.test(admin1.address_components[0]?.long_name ?? '')) {
    return { city: language === 'en' ? 'Tokyo' : '东京', cityPlaceId: admin1.place_id, countryCode, administrativeArea };
  }
  // 台湾按县市一级归（台北市、新竹县、高雄市），与内地按地级市分同一口径；Google 里县辖市（竹北市等）是 locality，不能用
  if (countryCode === 'TW' && admin1) {
    const city = admin1.address_components[0]?.long_name ?? admin1.formatted_address;
    return { city, cityPlaceId: admin1.place_id, countryCode, administrativeArea: city };
  }
  return { city: pick.address_components[0]?.long_name ?? pick.formatted_address, cityPlaceId: pick.place_id, countryCode, administrativeArea };
}
