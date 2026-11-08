/**
 * 店铺地图详情整理（2026-10-22）：高德 v5 / v3、Google Place Details (New) → 店上的 placeDetails
 *
 * 覆盖：
 *   a) 高德 v5：电话、一周与今日营业时间、评分、人均、特色、推荐、主标签、商圈；高德空值给 []，整理后去掉
 *   b) 高德 v3（转发没放行 v5 时的退路）：营业时间取 opentime2，没有推荐
 *   c) Google：电话、网址、按星期的营业时间、评分与人数、价位、营业状态、简介、服务项
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { normalizeAmapV3, normalizeAmapV5, normalizeGoogle } from '../src/lib/place-extras.js';

describe('normalizeAmapV5', () => {
  it('取全商家字段，空值去掉', () => {
    const d = normalizeAmapV5('B0FFGK1A65', {
      name: '一兰拉面(尖沙咀店)',
      type: '餐饮服务;中餐厅;中餐厅',
      business: {
        business_area: '尖沙咀', tel: '+852-23694218', tag: '一兰拉面,抹茶杏仁豆腐,半熟盐煮蛋', rectag: '拉面', keytag: '拉面',
        rating: '4.7', cost: '120.00', opentime_today: '09:00-03:00', opentime_week: '周一至周日 09:00-03:00', alias: [],
      },
      photos: [{ title: [], url: 'http://store.is.autonavi.com/showpic/x' }],
    });
    expect(d).toEqual({
      source: 'amap', id: 'B0FFGK1A65', api: 'amap-v5', name: '一兰拉面(尖沙咀店)', phone: '+852-23694218',
      hours: ['周一至周日 09:00-03:00'], hoursToday: '09:00-03:00', rating: 4.7, avgPrice: 120,
      tags: ['一兰拉面', '抹茶杏仁豆腐', '半熟盐煮蛋'], recommended: ['拉面'], keyTag: '拉面',
      type: '餐饮服务;中餐厅;中餐厅', businessArea: '尖沙咀',
    });
  });

  it('没有商家字段的店只留名字和类别', () => {
    expect(normalizeAmapV5('B0X', { name: '小店', type: '餐饮服务', business: { rating: [], cost: [] } }))
      .toEqual({ source: 'amap', id: 'B0X', api: 'amap-v5', name: '小店', type: '餐饮服务' });
  });
});

describe('normalizeAmapV3', () => {
  it('营业时间取 opentime2，评分、人均在 biz_ext 里', () => {
    const d = normalizeAmapV3('B0JD1A4Y33', {
      name: '老太婆小炒馆', type: '餐饮服务;中餐厅;中餐厅', tel: '18580673975', tag: '堂食,宫保鸡丁', keytag: '中餐', website: [],
      business_area: '九龙街道', biz_ext: { rating: '4.5', cost: '21.00', open_time: '11:30-14:30', opentime2: '周一至周日 11:30-14:30,17:00-20:00' },
    });
    expect(d).toEqual({
      source: 'amap', id: 'B0JD1A4Y33', api: 'amap-v3', name: '老太婆小炒馆', phone: '18580673975',
      hours: ['周一至周日 11:30-14:30,17:00-20:00'], rating: 4.5, avgPrice: 21, tags: ['堂食', '宫保鸡丁'], keyTag: '中餐',
      type: '餐饮服务;中餐厅;中餐厅', businessArea: '九龙街道',
    });
  });
});

describe('normalizeGoogle', () => {
  it('取电话、网址、营业时间、评分与人数、价位、营业状态、简介和服务项', () => {
    const d = normalizeGoogle('ChIJD3HtKxGuEmsROZ9vjoKRaEA', {
      displayName: { text: 'Blue Angel Restaurant' },
      nationalPhoneNumber: '(02) 9357 1491',
      internationalPhoneNumber: '+61 2 9357 1491',
      websiteUri: 'https://blueangel.example',
      googleMapsUri: 'https://maps.google.com/?cid=1',
      regularOpeningHours: { weekdayDescriptions: ['Monday: 5:30–10:00 PM', 'Tuesday: Closed'], periods: [{ open: { day: 1, hour: 17, minute: 30 } }] },
      timeZone: { id: 'Australia/Sydney' },
      rating: 4.2,
      userRatingCount: 812,
      priceLevel: 'PRICE_LEVEL_EXPENSIVE',
      businessStatus: 'OPERATIONAL',
      primaryType: 'italian_restaurant',
      primaryTypeDisplayName: { text: 'Italian Restaurant' },
      editorialSummary: { text: 'Seafood since 1961.' },
      dineIn: true,
      takeout: false,
      photos: [{ name: 'places/x/photos/y', widthPx: 1600, heightPx: 1200 }],
    });
    expect(d).toEqual({
      source: 'google', id: 'ChIJD3HtKxGuEmsROZ9vjoKRaEA', api: 'google', name: 'Blue Angel Restaurant',
      phone: '(02) 9357 1491', internationalPhone: '+61 2 9357 1491', website: 'https://blueangel.example',
      mapsUrl: 'https://maps.google.com/?cid=1', hours: ['Monday: 5:30–10:00 PM', 'Tuesday: Closed'],
      openingPeriods: [{ open: { day: 1, hour: 17, minute: 30 } }], timeZone: 'Australia/Sydney', rating: 4.2, ratingCount: 812,
      priceLevel: 'PRICE_LEVEL_EXPENSIVE', businessStatus: 'OPERATIONAL', type: 'italian_restaurant',
      typeLabel: 'Italian Restaurant', summary: 'Seafood since 1961.', options: { dineIn: true, takeout: false },
    });
  });
});
