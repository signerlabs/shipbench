/**
 * 小店详情页的地图详情（1.3.0 改版，2026-10-27）：把店上存的 placeDetails 整理成 App 直接显示的样子，
 * 给 GET /v1/restaurants/:id/place 用。纯函数，便于单测。
 *
 *   - 照片：S3 key → 图片域名地址；Google 的带作者（App 要署名）
 *   - 价位：高德人均按城市写货币（内地 ¥、香港港币、澳门澳门元）；Google 用价格区间（人均），没有区间退回价位档
 *   - 营业时间：高德的一周原文（如「周一至周日 10:30-14:50,17:20-22:10」）解析成按星期的时段；Google 用结构化 periods。
 *     能解析的给 periods（App 按店所在地时区算「营业中 / 休息中」）和重排过的中文几行；解析不了只给原文
 *   - 电话拆成数组（高德用分号隔开几个号码；Google 优先国际格式，境外打回去要带国家码）
 *   - 特色菜：高德的特色和推荐，去掉「单人餐」「面馆」这类不是菜的
 *   - 服务项：Google 的可订位、外带、外送等挑几个有用的译成中文
 */

import type { PlaceDetails } from './place-extras.js';

/** 一段营业时间（店所在地时间）：day 0 = 周日 … 6 = 周六；close 不晚于 open 表示过夜到次日，24:00 表示到当天结束 */
export interface PlaceInfoPeriod {
  day: number;
  open: string;
  close: string;
}

export interface PlaceInfo {
  source: 'amap' | 'google';
  photos: Array<{ url: string; author?: string }>;
  rating?: number;
  ratingCount?: number;
  priceText?: string;
  hoursLines: string[];
  periods?: PlaceInfoPeriod[];
  timeZone?: string;
  phones: string[];
  specialties: string[];
  services: string[];
}

const IMAGE_BASE = 'https://img.shopmap.example/';

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 一周按周一到周日排（行的顺序） */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_CHAR: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

const pad = (n: number): string => String(n).padStart(2, '0');

/** "9:5" → "09:05"；不合法返回 null（小时 0–24，24 只能是 24:00） */
function normTime(text: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** 「周一」「周五至周一」→ 星期几（0 = 周日），区间按周一到周日的顺序、可跨周末 */
function expandDays(spec: string): number[] {
  const days: number[] = [];
  for (const part of spec.split(/[,、]/)) {
    const m = /^周([一二三四五六日天])(?:至周([一二三四五六日天]))?$/.exec(part.trim());
    if (!m) continue;
    const toMondayFirst = (d: number): number => (d === 0 ? 7 : d);
    const start = toMondayFirst(DAY_CHAR[m[1]!]!);
    const end = toMondayFirst(DAY_CHAR[(m[2] ?? m[1])!]!);
    for (let i = 0, d = start; i < 7; i++) {
      days.push(d % 7);
      if (d === end) break;
      d = d === 7 ? 1 : d + 1;
    }
  }
  return [...new Set(days)];
}

/**
 * 高德一周营业时间原文 → 按星期的时段；一段也解析不出来返回 null。
 * 认得：「周一至周日 10:30-14:50,17:20-22:10」「周一至周五 …；周六至周日 …」「周一,周三至周日 …」、没写星期的（算每天）、
 * 「00:00-24:00」「24小时」。原文后面挂的节假日安排（「10-01至10-07 …」「2026-02-16至2026-02-18 … 全天关闭」「2026年春节期间 …」）
 * 和「最晚点餐 20:30」都不算：节假日早就过了，按平常的营业时间算
 */
export function parseAmapHours(text: string): PlaceInfoPeriod[] | null {
  let s = text
    .replace(/；/g, ';').replace(/，/g, ',').replace(/：/g, ':').replace(/[～~—－–]/g, '-')
    .replace(/最晚点餐\s*\d{1,2}:\d{2}/g, '');
  // 节假日安排从第一个日期起整段不要
  const holiday = /(\d{4}-)?\d{1,2}-\d{1,2}至|\d{4}年|春节|节假日|法定/.exec(s);
  if (holiday) s = s.slice(0, holiday.index);
  const periods: PlaceInfoPeriod[] = [];
  // 原文偶尔把同一段写两遍（「周二至周五/周二至周日:18:00-24:00；…；周二至周日:18:00-24:00」），同一天一样的时段只留一段
  const seen = new Set<string>();
  for (const segment of s.split(';')) {
    const seg = segment.trim().replace(/[,\s]+$/, '');
    if (!seg) continue;
    const m = /^((?:周[一二三四五六日天](?:至周[一二三四五六日天])?)(?:\s*[,、]\s*周[一二三四五六日天](?:至周[一二三四五六日天])?)*)?\s*:?\s*(.*)$/.exec(seg);
    if (!m) continue;
    const days = m[1] ? expandDays(m[1].replace(/\s+/g, '')) : [0, 1, 2, 3, 4, 5, 6];
    const rest = m[2] ?? '';
    const ranges: Array<[string, string]> = [];
    if (/24\s*小时|全天营业|^全天$/.test(rest)) {
      ranges.push(['00:00', '24:00']);
    } else {
      for (const r of rest.matchAll(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g)) {
        const open = normTime(r[1]!);
        const close = normTime(r[2]!);
        if (open && close && open !== close) ranges.push([open, close === '00:00' ? '24:00' : close]);
      }
    }
    for (const day of days) {
      for (const [open, close] of ranges) {
        const key = `${day}|${open}|${close}`;
        if (seen.has(key)) continue;
        seen.add(key);
        periods.push({ day, open, close });
      }
    }
  }
  return periods.length ? periods : null;
}

/** Google regularOpeningHours.periods → 按星期的时段；没有 close 的是 24 小时营业 */
export function googlePeriods(raw: unknown[] | undefined): PlaceInfoPeriod[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const at = (v: unknown): { day: number; hour: number; minute: number } | null => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    if (!o || typeof o['day'] !== 'number') return null;
    return { day: o['day'] as number, hour: Number(o['hour'] ?? 0), minute: Number(o['minute'] ?? 0) };
  };
  const periods: PlaceInfoPeriod[] = [];
  for (const p of raw) {
    const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    const open = at(o['open']);
    if (!open) continue;
    const close = at(o['close']);
    if (!close) {
      // 只有开门没有关门：全天营业
      return [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '24:00' }));
    }
    const closeText = close.hour === 0 && close.minute === 0 && close.day !== open.day ? '24:00' : `${pad(close.hour)}:${pad(close.minute)}`;
    periods.push({ day: open.day, open: `${pad(open.hour)}:${pad(open.minute)}`, close: closeText });
  }
  return periods.length ? periods : null;
}

/**
 * 时段 → 中文几行：周一到周日依次排，相邻几天时段一样的并成「周三至周日」；没有时段的天写「休息」
 * （Google 的数据是全的；高德原文没写到的天，如「周一,周三至周日」里的周二，就是不营业）
 */
export function formatHoursLines(periods: PlaceInfoPeriod[]): string[] {
  const textOf = (day: number): string => {
    const list = periods.filter((p) => p.day === day).sort((a, b) => a.open.localeCompare(b.open));
    if (list.some((p) => p.open === '00:00' && p.close === '24:00')) return '24 小时营业';
    return list.map((p) => `${p.open}–${p.close}`).join('、');
  };
  const lines: string[] = [];
  let group: number[] = [];
  const flush = (): void => {
    if (!group.length) return;
    const text = textOf(group[0]!) || '休息';
    const label = group.length === 1 ? DAY_NAMES[group[0]!] : `${DAY_NAMES[group[0]!]}至${DAY_NAMES[group[group.length - 1]!]}`;
    lines.push(`${label} ${text}`);
    group = [];
  };
  for (const day of WEEK_ORDER) {
    if (group.length && textOf(group[0]!) !== textOf(day)) flush();
    group.push(day);
  }
  flush();
  return lines;
}

const CURRENCY: Record<string, string> = {
  CNY: '元', HKD: '港币', MOP: '澳门元', TWD: '新台币', JPY: '日元', KRW: '韩元', THB: '泰铢', SGD: '新加坡元',
  MYR: '林吉特', VND: '越南盾', IDR: '印尼盾', PHP: '菲律宾比索', USD: '美元', CAD: '加元', GBP: '英镑', EUR: '欧元',
  AUD: '澳元', NZD: '新西兰元', CHF: '瑞士法郎', AED: '迪拉姆', TRY: '土耳其里拉',
};
const PRICE_LEVEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: '价位便宜', PRICE_LEVEL_MODERATE: '价位中等', PRICE_LEVEL_EXPENSIVE: '价位偏贵', PRICE_LEVEL_VERY_EXPENSIVE: '价位很贵',
};

function priceText(pd: PlaceDetails, city: string | undefined): string | undefined {
  if (pd.source === 'amap') {
    if (typeof pd.avgPrice !== 'number' || pd.avgPrice <= 0) return undefined;
    const n = Math.round(pd.avgPrice);
    if (city?.includes('香港')) return `人均 ${n} 港币`;
    if (city?.includes('澳门')) return `人均 ${n} 澳门元`;
    return `人均 ¥${n}`;
  }
  const range = pd.priceRange && typeof pd.priceRange === 'object' ? (pd.priceRange as Record<string, unknown>) : null;
  const money = (v: unknown): { units: number; code: string } | null => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    const units = Number(o?.['units']);
    return o && Number.isFinite(units) && units > 0 ? { units, code: String(o['currencyCode'] ?? '') } : null;
  };
  const start = money(range?.['startPrice']);
  const end = money(range?.['endPrice']);
  if (start) {
    const unit = CURRENCY[start.code] ?? start.code;
    const fmt = (n: number): string => n.toLocaleString('en-US');
    return end ? `人均 ${fmt(start.units)}–${fmt(end.units)} ${unit}` : `人均 ${fmt(start.units)} ${unit}起`;
  }
  return pd.priceLevel ? PRICE_LEVEL[pd.priceLevel] : undefined;
}

/** 不是菜的特色、推荐（高德常把份量、店的类别也写进来） */
const NOT_DISH = /^(单人餐|双人餐|三人餐|四人餐|多人餐|.*套餐|招牌菜|特色菜|面馆|饭馆|饭店|餐厅|餐馆|快餐|小吃|中餐|西餐|聚餐|下午茶|早餐|午餐|晚餐|夜宵|宵夜|外卖)$/;

const SERVICES: Array<[string, string]> = [
  ['reservable', '可订位'], ['takeout', '外带'], ['delivery', '外送'], ['outdoorSeating', '户外座位'],
  ['servesVegetarianFood', '有素食'], ['goodForChildren', '适合带孩子'],
];

export function toPlaceInfo(pd: PlaceDetails, ctx: { city?: string } = {}): PlaceInfo {
  const photos = (pd.photos ?? [])
    .filter((p) => typeof p.key === 'string' && p.key)
    .map((p) => ({ url: IMAGE_BASE + p.key, ...(p.author ? { author: p.author } : {}) }));

  let periods: PlaceInfoPeriod[] | null = null;
  let hoursLines: string[] = [];
  if (pd.source === 'google') {
    periods = googlePeriods(pd.openingPeriods);
    hoursLines = periods ? formatHoursLines(periods) : [];
  } else {
    const week = (pd.hours ?? []).join('；').trim();
    periods = week ? parseAmapHours(week) : null;
    hoursLines = periods ? formatHoursLines(periods) : week ? [week] : [];
  }

  const phoneText = pd.source === 'google' ? (pd.internationalPhone || pd.phone || '') : (pd.phone || '');
  const phones = [...new Set(phoneText.split(/[;；,，]/).map((s) => s.trim()).filter(Boolean))];

  const specialties = [...new Set([...(pd.tags ?? []), ...(pd.recommended ?? [])].map((s) => s.trim()))]
    .filter((s) => s && !NOT_DISH.test(s) && s !== pd.keyTag)
    .slice(0, 8);

  const services = SERVICES.filter(([k]) => pd.options?.[k] === true).map(([, label]) => label);

  const price = priceText(pd, ctx.city);
  const timeZone = pd.source === 'amap' ? 'Asia/Shanghai' : pd.timeZone;
  return {
    source: pd.source,
    photos,
    ...(typeof pd.rating === 'number' && pd.rating > 0 ? { rating: pd.rating } : {}),
    ...(typeof pd.ratingCount === 'number' && pd.ratingCount > 0 ? { ratingCount: pd.ratingCount } : {}),
    ...(price ? { priceText: price } : {}),
    hoursLines,
    ...(periods ? { periods } : {}),
    ...(timeZone ? { timeZone } : {}),
    phones,
    specialties,
    services,
  };
}
