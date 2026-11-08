/**
 * 帖子标签入库前的清洗 sanitizeTags 单元测试（2026-10-26）
 *
 * 覆盖：
 *   a) 带抖音的（含 dou 的叫法）、创作者头衔与流量计划：去掉
 *   b) 推荐者本人的名号：去掉；名字里带菜名、标签又出现在店名或菜名里的：留着；只占名字一小段的：留着
 *   c) 去空白、去开头的 #、去重；不是数组回空数组
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { sanitizeTags } from '../src/lib/post-tags.js';

describe('sanitizeTags：帖子标签入库前的清洗', () => {
  it('带抖音的、创作者头衔与流量计划：去掉', () => {
    expect(sanitizeTags(
      ['抖音美食推荐官', '#抖音心动餐厅', '重庆dou知道', 'DOU+小助手', '舌尖上的抖音', '美食推荐官', '青年创作者扶持计划', '探店达人', '饸饹面', '麻辣'],
    )).toEqual(['饸饹面', '麻辣']);
  });

  it('推荐者本人的名号：去掉（含括号里的补充说明）', () => {
    expect(sanitizeTags(['乌啦啦', '特别乌啦啦', '河南美食', '饸饹面'], { influencerName: '特别乌啦啦' }))
      .toEqual(['河南美食', '饸饹面']);
    expect(sanitizeTags(['隋坡', '锅包肉'], { influencerName: '特厨隋坡（重新出发版）' })).toEqual(['锅包肉']);
  });

  it('推荐者是店家自己的号、名字里带菜名：标签出现在店名或菜名里就留着', () => {
    expect(sanitizeTags(['重庆小火锅', '毛肚'], {
      influencerName: '我和你重庆小火锅',
      restaurantNames: ['我和你重庆小火锅(观音桥店)'],
    })).toEqual(['重庆小火锅', '毛肚']);
    expect(sanitizeTags(['日式拉面'], { influencerName: '汤屋日式拉面', dishNames: ['豚骨日式拉面'] })).toEqual(['日式拉面']);
  });

  it('只占推荐者名字一小段的（多半在说口味）：留着', () => {
    expect(sanitizeTags(['麻辣', '火锅'], { influencerName: '麻辣小火郭' })).toEqual(['麻辣', '火锅']);
  });

  it('去空白、去开头的 #、去重；不是数组回空数组', () => {
    expect(sanitizeTags([' 川菜 ', '#川菜', '', 3, '炭烤'])).toEqual(['川菜', '炭烤']);
    expect(sanitizeTags(undefined)).toEqual([]);
  });
});
