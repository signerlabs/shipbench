/**
 * 城市分层（2026-07-08 方案 B）核心纯函数单测
 *
 * 覆盖：
 *   - deriveCityLayers 三层归并（含直辖市 regeo city 空数组 → 省兜底）
 *   - cityLoopbackPass 城市回环校验（防境外伪命中 + 县级市不误杀）
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { deriveCityLayers, cityLoopbackPass } from '../src/lib/amap-geocode.js';

describe('deriveCityLayers 三层归并', () => {
  it('自治州辖县级市：延边州 / 延吉市', () => {
    expect(deriveCityLayers('吉林省', '延边朝鲜族自治州', '延吉市')).toEqual({
      administrativeArea: '吉林省', locality: '延边朝鲜族自治州', subLocality: '延吉市',
    });
  });
  it('地级市辖县级市：苏州市 / 昆山市', () => {
    expect(deriveCityLayers('江苏省', '苏州市', '昆山市')).toEqual({
      administrativeArea: '江苏省', locality: '苏州市', subLocality: '昆山市',
    });
  });
  it('直辖市 place/text：北京市 / 东城区', () => {
    expect(deriveCityLayers('北京市', '北京市', '东城区')).toEqual({
      administrativeArea: '北京市', locality: '北京市', subLocality: '东城区',
    });
  });
  it('直辖市 regeo city 返回空数组 → locality 用省兜底', () => {
    // regeo 对直辖市的 addressComponent.city 返回 [] 空数组
    expect(deriveCityLayers('北京市', [], '东城区')).toEqual({
      administrativeArea: '北京市', locality: '北京市', subLocality: '东城区',
    });
    expect(deriveCityLayers('上海市', [], '黄浦区').locality).toBe('上海市');
  });
  it('省直辖县级市 / 兵团市 regeo city 空数组 → locality 用县级名（不落省名）', () => {
    // 潜江/文昌/万宁/石河子这类无地级父级的县级市，regeo city 返回 []，
    // 按地级处理：locality = subLocality 县级名，绝不污染成 CITY#湖北省
    expect(deriveCityLayers('湖北省', [], '潜江市')).toEqual({
      administrativeArea: '湖北省', locality: '潜江市', subLocality: '潜江市',
    });
    expect(deriveCityLayers('海南省', [], '文昌市').locality).toBe('文昌市');
    expect(deriveCityLayers('海南省', [], '万宁市').locality).toBe('万宁市');
    expect(deriveCityLayers('新疆维吾尔自治区', [], '石河子市').locality).toBe('石河子市');
  });
  it('极端兜底：省 + city 空 + district 也空 → 回落省名防崩', () => {
    expect(deriveCityLayers('湖北省', [], '')).toEqual({
      administrativeArea: '湖北省', locality: '湖北省', subLocality: '',
    });
  });
});

describe('cityLoopbackPass 城市回环校验（意图 ∈ {locality, subLocality}）', () => {
  it('正常店回环通过（县级市靠 subLocality 对上，不误杀）', () => {
    expect(cityLoopbackPass('延吉市', '延边朝鲜族自治州', '延吉市')).toBe(true);
    expect(cityLoopbackPass('昆山市', '苏州市', '昆山市')).toBe(true);
    expect(cityLoopbackPass('成都市', '成都市', '锦江区')).toBe(true);
    expect(cityLoopbackPass('北京市', '北京市', '东城区')).toBe(true);
  });
  it('境外伪命中被拦（意图 ∉ 返回的国内地名）', () => {
    expect(cityLoopbackPass('东京都', '廊坊市', '固安县')).toBe(false); // 沙县小吃穿透闸③被回环拦
    expect(cityLoopbackPass('大阪', '廊坊市', '三河市')).toBe(false);   // 星巴克
    expect(cityLoopbackPass('东京都', '北京市', '西城区')).toBe(false); // 蜜雪冰城
  });
  it('空意图 → false', () => {
    expect(cityLoopbackPass('', '成都市', '锦江区')).toBe(false);
  });
});
