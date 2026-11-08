/**
 * Google 地图查法 google-places.ts 单元测试（2026-10-21）
 *
 * 覆盖：isFoodPlace——餐饮类收、行政区交通站酒店不收；Google 只标了泛类别的不排除
 *（台湾不少奶茶店只有 point_of_interest、establishment，10/21 考卷鬍子茶、MATEAS 因此被筛掉）
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { isFoodPlace } from '../src/lib/google-places.js';

describe('isFoodPlace', () => {
  it('餐饮类收，行政区、交通站、酒店不收（哪怕同时带了餐饮类别）', () => {
    expect(isFoodPlace(['ramen_restaurant', 'point_of_interest', 'establishment'])).toBe(true);
    expect(isFoodPlace(['tea_house', 'point_of_interest'])).toBe(true);
    expect(isFoodPlace(['locality', 'political'])).toBe(false);
    expect(isFoodPlace(['lodging', 'restaurant', 'point_of_interest'])).toBe(false);
  });

  it('只标了泛类别的不排除，有具体非餐饮类别的排除', () => {
    expect(isFoodPlace(['point_of_interest', 'establishment'])).toBe(true);
    expect(isFoodPlace(['service', 'point_of_interest', 'establishment'])).toBe(true);
    expect(isFoodPlace(['clothing_store', 'store', 'point_of_interest', 'establishment'])).toBe(false);
    expect(isFoodPlace([])).toBe(false);
  });
});
