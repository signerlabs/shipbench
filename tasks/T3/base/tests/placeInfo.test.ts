/**
 * 小店详情页的地图详情整理（place-info.ts）单元测试（2026-10-27）
 *
 * 覆盖：
 *   a) 高德一周营业时间的常见写法：一段、两段、分号分组、逗号列星期、跨周末、没写星期、24 小时、过夜；
 *      节假日安排和「最晚点餐」不算；解析不了返回 null
 *   b) Google periods：普通、没有关门时间（全天）、半夜关门写成 24:00
 *   c) 中文几行：相邻同时段的天合并；没写到的天是「休息」
 *   d) 两家真实店（郑州肖家客饸饹面、镰仓 yoridokoro）整理成 App 要的样子；港澳人均用当地货币
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { formatHoursLines, googlePeriods, parseAmapHours, toPlaceInfo } from '../src/lib/place-info.js';
import type { PlaceDetails } from '../src/lib/place-extras.js';

const daysOf = (periods: ReturnType<typeof parseAmapHours>, open: string): number[] =>
  (periods ?? []).filter((p) => p.open === open).map((p) => p.day).sort();

describe('parseAmapHours：高德一周营业时间', () => {
  it('「周一至周日」两段：每天两段', () => {
    const p = parseAmapHours('周一至周日 10:30-14:50,17:20-22:10')!;
    expect(p).toHaveLength(14);
    expect(p).toContainEqual({ day: 0, open: '10:30', close: '14:50' });
    expect(p).toContainEqual({ day: 3, open: '17:20', close: '22:10' });
  });

  it('分号分组、逗号列星期、跨周末的区间', () => {
    expect(daysOf(parseAmapHours('周一至周五 10:00-21:00；周六至周日 9:00-22:00'), '09:00')).toEqual([0, 6]);
    expect(daysOf(parseAmapHours('周一,周三至周日 10:00-21:00'), '10:00')).toEqual([0, 1, 3, 4, 5, 6]);
    expect(daysOf(parseAmapHours('周五至周一 18:00-23:00'), '18:00')).toEqual([0, 1, 5, 6]);
  });

  it('没写星期算每天；24 小时；半夜关门写成 24:00；过夜照原样（关门早于开门）', () => {
    expect(parseAmapHours('10:00-22:00')).toHaveLength(7);
    expect(parseAmapHours('周一至周日 00:00-24:00')![0]).toEqual({ day: 1, open: '00:00', close: '24:00' });
    expect(parseAmapHours('24小时营业')![0]).toMatchObject({ open: '00:00', close: '24:00' });
    expect(parseAmapHours('周一至周日 17:00-00:00')![0]).toMatchObject({ open: '17:00', close: '24:00' });
    expect(parseAmapHours('周一至周日 18:00-02:00')![0]).toMatchObject({ open: '18:00', close: '02:00' });
  });

  it('节假日安排、「最晚点餐」不算；全角标点也认', () => {
    expect(parseAmapHours('周一至周日 10:00-21:00 10-01至10-07 周一至周日 10:00-22:00')).toHaveLength(7);
    expect(parseAmapHours('周一至周日 11:00-14:00,17:00-21:00 2026-02-16至2026-02-18 周一至周日 全天关闭')).toHaveLength(14);
    expect(parseAmapHours('10:00-22:00,2026年春节期间 10:00-20:00')).toHaveLength(7);
    expect(parseAmapHours('周一至周日 11:00-14:00,17:00-21:30 最晚点餐20:30')).toHaveLength(14);
    expect(parseAmapHours('周一至周日 10:00-14:00，17:00-21:00')).toHaveLength(14);
  });

  it('原文同一段写两遍：同一天一样的时段只留一段（VEA Restaurant 的原文）', () => {
    const p = parseAmapHours('周二至周五/周二至周日:18:00-24:00；周六/13:00-17:00；周二至周日:18:00-24:00周日及')!;
    expect(p.filter((x) => x.day === 2)).toEqual([{ day: 2, open: '18:00', close: '24:00' }]);
    expect(formatHoursLines(p)).toEqual(['周一 休息', '周二至周五 18:00–24:00', '周六 13:00–17:00、18:00–24:00', '周日 18:00–24:00']);
  });

  it('解析不了返回 null', () => {
    expect(parseAmapHours('营业时间请致电询问')).toBeNull();
    expect(parseAmapHours('')).toBeNull();
  });
});

describe('googlePeriods：Google 结构化营业时间', () => {
  it('普通时段；半夜关门写成 24:00', () => {
    expect(googlePeriods([
      { open: { day: 1, hour: 7, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } },
      { open: { day: 5, hour: 18, minute: 30 }, close: { day: 6, hour: 0, minute: 0 } },
    ])).toEqual([
      { day: 1, open: '07:00', close: '17:00' },
      { day: 5, open: '18:30', close: '24:00' },
    ]);
  });

  it('只有开门没有关门：全天营业；没有数据为 null', () => {
    expect(googlePeriods([{ open: { day: 0, hour: 0, minute: 0 } }])).toHaveLength(7);
    expect(googlePeriods([])).toBeNull();
    expect(googlePeriods(undefined)).toBeNull();
  });
});

describe('formatHoursLines：中文几行', () => {
  it('相邻同时段的天合并；没写到的天写「休息」', () => {
    const periods = [1, 3, 4, 5, 6, 0].map((day) => ({ day, open: '07:00', close: '17:00' }));
    expect(formatHoursLines(periods)).toEqual(['周一 07:00–17:00', '周二 休息', '周三至周日 07:00–17:00']);
    const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' }));
    expect(formatHoursLines(weekdays)).toEqual(['周一至周五 09:00–18:00', '周六至周日 休息']);
  });

  it('24 小时写成「24 小时营业」', () => {
    expect(formatHoursLines(parseAmapHours('周一至周日 00:00-24:00')!)).toEqual(['周一至周日 24 小时营业']);
  });
});

describe('toPlaceInfo：整理成 App 要的样子', () => {
  it('高德：郑州肖家客饸饹面', () => {
    const pd: PlaceDetails = {
      source: 'amap', id: 'B0FFFY46NQ', api: 'amap-v5', fetchedAt: '2026-10-26T09:57:58.410Z',
      name: '肖家客饸饹面(郑州总店)', phone: '13333862126;13673713806',
      hours: ['周一至周日 10:30-14:50,17:20-22:10'], hoursToday: '10:30-14:50 17:20-22:10',
      rating: 4.7, avgPrice: 14, keyTag: '面馆', recommended: ['面馆'],
      tags: ['豆腐菜', '饸烙面', '凉菜', '招牌萝卜', '本地山羊肉', '单人餐', '羊肉汤'],
      photos: [0, 1, 2].map((i) => ({ key: `place-photos/6936008432562588936/amap-${i}.jpg` })),
      photoTotal: 3, rawKey: 'place-details/6936008432562588936/amap-B0FFFY46NQ.json',
    };
    const info = toPlaceInfo(pd, { city: '郑州市' });
    expect(info).toMatchObject({
      source: 'amap', rating: 4.7, priceText: '人均 ¥14', timeZone: 'Asia/Shanghai',
      phones: ['13333862126', '13673713806'],
      specialties: ['豆腐菜', '饸烙面', '凉菜', '招牌萝卜', '本地山羊肉', '羊肉汤'],
      services: [], hoursLines: ['周一至周日 10:30–14:50、17:20–22:10'],
    });
    expect(info.photos[0]).toEqual({ url: 'https://img.shopmap.example/place-photos/6936008432562588936/amap-0.jpg' });
    expect(info.periods).toHaveLength(14);
    expect(info.ratingCount).toBeUndefined();
  });

  it('Google：镰仓 yoridokoro（照片带作者、价格区间、国际电话、服务项、时区）', () => {
    const pd: PlaceDetails = {
      source: 'google', id: 'ChIJAQA96VlPGGAR0TqpQJDAg_A', api: 'google', fetchedAt: '2026-10-22T03:52:59.061Z',
      phone: '0467-40-5737', internationalPhone: '+81 467-40-5737', rating: 4.2, ratingCount: 1713,
      hours: ['Monday: 7:00 AM – 5:00 PM', 'Tuesday: Closed'],
      openingPeriods: [1, 3, 4, 5, 6, 0].map((day) => ({ open: { day, hour: 7, minute: 0 }, close: { day, hour: 17, minute: 0 } })),
      timeZone: 'Asia/Tokyo', priceLevel: 'PRICE_LEVEL_MODERATE',
      priceRange: { startPrice: { currencyCode: 'JPY', units: '1000' }, endPrice: { currencyCode: 'JPY', units: '2000' } },
      options: { dineIn: true, takeout: true, delivery: true, reservable: true, outdoorSeating: true, servesBeer: true, allowsDogs: false },
      photos: [{ key: 'place-photos/7138717783956786445/google-0.jpg', author: 'NaiYai', authorUri: 'https://maps.google.com/maps/contrib/1' }],
      photoTotal: 10, rawKey: 'place-details/7138717783956786445/google-x.json',
    };
    expect(toPlaceInfo(pd, { city: 'Kamakura' })).toEqual({
      source: 'google',
      photos: [{ url: 'https://img.shopmap.example/place-photos/7138717783956786445/google-0.jpg', author: 'NaiYai' }],
      rating: 4.2, ratingCount: 1713, priceText: '人均 1,000–2,000 日元',
      hoursLines: ['周一 07:00–17:00', '周二 休息', '周三至周日 07:00–17:00'],
      periods: [1, 3, 4, 5, 6, 0].map((day) => ({ day, open: '07:00', close: '17:00' })),
      timeZone: 'Asia/Tokyo', phones: ['+81 467-40-5737'], specialties: [],
      services: ['可订位', '外带', '外送', '户外座位'],
    });
  });

  it('港澳人均用当地货币；没有价格区间退回价位档；解析不了的营业时间只给原文', () => {
    const base = { id: 'x', api: 'amap-v5', fetchedAt: '', photos: [], photoTotal: 0, rawKey: '' } as const;
    expect(toPlaceInfo({ ...base, source: 'amap', avgPrice: 80 }, { city: '香港特别行政区' }).priceText).toBe('人均 80 港币');
    expect(toPlaceInfo({ ...base, source: 'amap', avgPrice: 120 }, { city: '澳门特别行政区' }).priceText).toBe('人均 120 澳门元');
    expect(toPlaceInfo({ ...base, source: 'google', priceLevel: 'PRICE_LEVEL_EXPENSIVE' }).priceText).toBe('价位偏贵');
    const odd = toPlaceInfo({ ...base, source: 'amap', hours: ['营业时间请致电询问'] });
    expect(odd.hoursLines).toEqual(['营业时间请致电询问']);
    expect(odd.periods).toBeUndefined();
  });
});
