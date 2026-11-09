#!/usr/bin/env python3
"""汇总一轮的成绩：python3 tools/build_round.py round-01

读 rounds/<轮>.json（这一轮挑了哪些题、每题的运行记录在哪个批次）和本机 runs/<批次>/<题>/<工具>/ 下的
meta.json、grade.json、rating.json，算出每题的质量分、速度分、成本分，再按维度权重合成，
写到 public/reports/<轮>/summary.json，并把同一份数据填进 public/reports/<轮>/index.html 里的
<script type="application/json" id="round-data"> 块（报告页从这里读数据，页面本身不用改）。

- 质量：修 bug、守规矩、后端 = 判对错 70% + 代码质量 30%；前端 = 自动比对 30% + 录屏评分 70%（都在 rating.json 里算好）
- 速度、成本：每题 50 + 25 × log2(基准 ÷ 实际)，截在 0–100；基准取第一轮两家的几何平均，定下后存进 rounds/references.json 冻结
  质量低于 60 或碰到 3 小时安全上限的题，速度分和成本分记 0
- 花费按 API 标价折算：Claude Code 用工具自报的 total_cost_usd；Codex 按 rounds/<轮>.json 里的每百万 token 标价算
- 还没跑完或还没评完的题标 pending，相关的维度分和总分也留空
"""
import json, math, os, re, sys

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(BENCH)
REFS = os.path.join(BENCH, 'rounds', 'references.json')

TASK_INFO = {
    'S1': {'level': 'easy', 'zh': '剪贴板 App 数据层：两台 Mac 同步来的同一条置顶，去重时留下的不一样', 'en': 'Clipboard app data layer: duplicate pins synced from two Macs are deduplicated differently', 'lang': 'Swift'},
    'S2': {'level': 'hard', 'zh': '剪贴板 App 数据层：搜索翻页回到开头、Pinboard 拖不动（只写现象）', 'en': 'Clipboard app data layer: search paging jumps back to the start, Pinboard items won\'t move (symptoms only)', 'lang': 'Swift'},
    'F1': {'level': 'hard', 'zh': '照录屏复刻美食地图 App 的三步引导页，含插画动画', 'en': 'Rebuild a food-map app\'s three-step onboarding from a recording, illustrations animated', 'lang': 'SwiftUI'},
    'F2': {'level': 'easy', 'zh': '照录屏复刻 Trovy 的统计报表页和房间详情页', 'en': 'Rebuild Trovy\'s stats report and room detail screens from a recording', 'lang': 'SwiftUI'},
    'B2': {'level': 'hard', 'zh': '按需求从零搭家庭物品与过期提醒服务（49 条隐藏验收）', 'en': 'Build a household inventory and expiry-reminder service from a spec (49 hidden checks)', 'lang': 'TypeScript · Workers + D1'},
    'B4': {'level': 'easy', 'zh': '按需求搭会员订阅回调服务（17 条隐藏验收）', 'en': 'Build a subscription webhook service from a spec (17 hidden checks)', 'lang': 'TypeScript · Workers + D1'},
    'R5': {'level': 'easy', 'zh': '用 ShipSwift 组件加「编辑习惯」和全局提示', 'en': 'Add habit editing and a global toast with ShipSwift components', 'lang': 'SwiftUI'},
    'R9': {'level': 'hard', 'zh': '健身 App 加花费页，避开四份文档里写明的坑', 'en': 'Add an expenses screen to a fitness app without hitting the pitfalls in four docs', 'lang': 'SwiftUI'},
}
RULES = {
    'S1': {'zh': '判对错：用隐藏测试替换对应的测试文件，`swift test` 全过记 100，有挂或编不过记 0。', 'en': 'Correctness: the hidden test replaces the matching test file; `swift test` passing completely scores 100, any failure or a build error scores 0.'},
    'S2': {'zh': '判对错：8 个隐藏回归用例，过几个算几分（每个 12.5）；其他测试有挂、或原有 38 个测试少了，分数减半；编不过 0 分。', 'en': 'Correctness: 8 hidden regression tests, 12.5 points each; halved if any other test fails or any of the 38 original tests is missing; 0 if it does not build.'},
    'F1': {'zh': '先要编译通过、装得上（不然 0 分）。自动比对占 30%：回放后三步演完的停稳画面和原录屏比相似度（空白工程 0、原录屏 100）。录屏评分占 70%：静态还原、动效还原、交互手感各 1–10 分，平均 × 10，每少 1 分，本题少约 2.3 分。', 'en': 'It must build and install, or it scores 0. Automatic comparison, 30%: the three settled screens after replay are compared with the original (an empty project scores 0, the original 100). Video review, 70%: static fidelity, motion and interaction feel, 1–10 each, averaged × 10; each point lost costs about 2.3 points on the task.'},
    'F2': {'zh': '同 F1：编译安装是门槛；自动比对 7 个状态占 30%；录屏评分三项占 70%。', 'en': 'Same as F1: building and installing is the gate; automatic comparison of 7 states, 30%; video review on three axes, 70%.'},
    'B2': {'zh': '判对错：49 条隐藏接口验收（功能 22、鉴权与隔离 13、健壮性 14），按通过比例给分。代码质量五项各 1–10 分，平均 × 10；每少 1 分，本题少 0.6 分。', 'en': 'Correctness: 49 hidden API checks (22 features, 13 auth and isolation, 14 robustness), scored by the share passed. Code quality: five criteria, 1–10 each, averaged × 10; each point lost costs 0.6 on the task.'},
    'B4': {'zh': '判对错：17 条隐藏接口验收（鉴权、校验、状态流转、重复和乱序推送、10 路并发、字段完整），按通过比例给分。代码质量同 B2。', 'en': 'Correctness: 17 hidden API checks (auth, validation, state transitions, duplicate and out-of-order events, 10 concurrent deliveries, complete fields), scored by the share passed. Code quality as in B2.'},
    'R5': {'zh': '判对错：先要能编译；再看 9 条静态检查（提示组件的用法、挂载位置、不等弹窗关闭、不自己做横幅、不写 iOS 18 兼容分支、不改 ShipSwift 源码和工程设置），违反一条扣一条的分。代码质量同 B2。', 'en': 'Correctness: it must build; then 9 static checks (alert component usage, where it is attached, no waiting for the sheet to close, no hand-made banners, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched), each violation costs its share. Code quality as in B2.'},
    'R9': {'zh': '判对错：两道门（能编译、真的做了需求）不过记 0；再看 14 条静态检查（该用的组件、按地区解析金额和日期、纯日期不按 UTC 解析等），违反一条扣一条的分。代码质量同 B2。', 'en': 'Correctness: two gates (it builds; the feature is really implemented), failing either scores 0; then 14 static checks (the right components, locale-aware amounts and dates, no UTC parsing of date-only values and more), each violation costs its share. Code quality as in B2.'},
}
STATE_EN = {'第 1 步演完': 'Step 1 settled', '第 2 步演完': 'Step 2 settled', '第 3 步演完': 'Step 3 settled',
            '首屏': 'First screen', '选中 Clothing': 'Clothing selected', '选中 Home': 'Home selected', '取消选中': 'Deselected',
            '往下滚': 'Scrolled down', 'Bedroom 详情': 'Bedroom detail', '返回报表页': 'Back to the report'}
SR_CRIT = ['结构与分层', '可读性', '一致性', '稳健写法', '可维护性']
F_CRIT = ['静态还原', '动效还原', '交互手感']


def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


def cost_of(meta, tool, prices):
    if meta.get('cost_usd') is not None:
        return round(meta['cost_usd'], 2)
    p = prices.get(tool)
    u = meta.get('usage') or {}
    if not p or not u:
        return None
    cached = u.get('cached_input_tokens', 0)
    return round(((u.get('input_tokens', 0) - cached) * p['input'] + cached * p['cached_input'] + u.get('output_tokens', 0) * p['output']) / 1e6, 2)


def rel_score(ref, actual):
    if not ref or not actual:
        return None
    return round(max(0, min(100, 50 + 25 * math.log2(ref / actual))), 1)


def main(rid):
    rd = json.load(open(os.path.join(BENCH, 'rounds', f'{rid}.json')))
    refs = load(REFS) or {}
    tools = list(rd['tools'])
    tasks = {}
    for dim in rd['dimensions']:
        for t in dim['tasks']:
            batch = rd['runs'][t]
            tdir = os.path.join(ROOT, 'runs', batch, t)
            rating = load(os.path.join(tdir, 'rating.json')) or {}
            entry = {'dimension': dim['key'], 'batch': batch, **TASK_INFO.get(t, {}), 'rule': RULES.get(t), 'tools': {}}
            for k in tools:
                meta = load(os.path.join(tdir, k, 'meta.json'))
                grade = load(os.path.join(tdir, k, 'grade.json'))
                r = rating.get(k) or {}
                e = {'status': 'pending'}
                if meta:
                    e.update({'seconds': meta.get('seconds'), 'cost_usd': cost_of(meta, k, rd.get('prices_per_mtok', {})),
                              'tool_calls': meta.get('tool_calls'), 'hit_cap': bool(meta.get('hit_cap')),
                              'safety_violations': meta.get('danger') or [], 'version': meta.get('version'), 'effort': meta.get('effort')})
                if t.startswith('F'):
                    if r.get(t) is not None:
                        e.update({'status': 'done', 'quality': r[t], 'auto': r.get('自动分'), 'video': r.get('录屏评分'),
                                  'video_scores': {c: r.get(c) for c in F_CRIT}, 'rationale': r.get('理由'),
                                  'rationale_en': r.get('理由_en'), 'auto_states': r.get('自动分明细')})
                    elif meta:
                        e['status'] = 'awaiting-review'
                    # 自动比对不用等评审：回放判完就有
                    fs = load(os.path.join(tdir, k, 'f2-score.json'))
                    if fs and e.get('auto') is None:
                        e['auto'] = fs.get('score')
                        e['auto_states'] = [{'state': x['state'], 'state_en': STATE_EN.get(x['state'], x['state']), 'score': x['score']} for x in fs.get('shots', [])]
                else:
                    if grade:
                        e['correctness'] = grade.get('score', grade.get('acceptance_score'))
                    if r.get(t) is not None:
                        e.update({'status': 'done', 'quality': r[t], 'code_quality': r.get('代码质量'),
                                  'code_scores': {c: r.get(c) for c in SR_CRIT}, 'rationale': r.get('理由'),
                                  'rationale_en': r.get('理由_en')})
                    elif meta and grade:
                        e['status'] = 'awaiting-review'
                entry['tools'][k] = e
            # 速度、成本的基准：两家都跑完才定，定下就冻结
            vals = {k: entry['tools'][k] for k in tools}
            if t not in refs and all(v.get('seconds') for v in vals.values()) and all(v.get('cost_usd') for v in vals.values()):
                refs[t] = {'seconds': round(math.exp(sum(math.log(v['seconds']) for v in vals.values()) / len(vals)), 2),
                           'cost_usd': round(math.exp(sum(math.log(v['cost_usd']) for v in vals.values()) / len(vals)), 3),
                           'set_in': rid}
            if t in refs:
                entry['reference'] = refs[t]
                for k, v in vals.items():
                    if v['status'] == 'done':
                        bad = v.get('hit_cap') or (v.get('quality') or 0) < 60
                        v['speed'] = 0 if bad else rel_score(refs[t]['seconds'], v.get('seconds'))
                        v['cost'] = 0 if bad else rel_score(refs[t]['cost_usd'], v.get('cost_usd'))
            tasks[t] = entry
    totals = {}
    for k in tools:
        tot = {'quality': 0, 'speed': 0, 'cost': 0, 'seconds': 0, 'cost_usd': 0, 'complete': True, 'dimensions': {}}
        for dim in rd['dimensions']:
            vs = [tasks[t]['tools'][k] for t in dim['tasks']]
            d = {}
            for m in ('quality', 'speed', 'cost'):
                xs = [v.get(m) for v in vs]
                d[m] = round(sum(xs) / len(xs), 1) if all(x is not None for x in xs) else None
                if d[m] is None:
                    tot['complete'] = False
                else:
                    tot[m] += dim['weight'] * d[m]
            tot['dimensions'][dim['key']] = d
            tot['seconds'] += sum(v.get('seconds') or 0 for v in vs)
            tot['cost_usd'] += sum(v.get('cost_usd') or 0 for v in vs)
        for m in ('quality', 'speed', 'cost'):
            tot[m] = round(tot[m], 1) if tot['complete'] else None
        tot['cost_usd'] = round(tot['cost_usd'], 2)
        totals[k] = tot
    out = {'round': rid, 'title': rd['title'], 'dates': rd['dates'], 'note': rd['note'], 'tools': rd['tools'],
           'dimensions': [{'key': d['key'], 'weight': d['weight'], 'tasks': d['tasks']} for d in rd['dimensions']],
           'prices_per_mtok': rd.get('prices_per_mtok'), 'tasks': tasks, 'totals': totals}
    json.dump(refs, open(REFS, 'w'), ensure_ascii=False, indent=1)
    od = os.path.join(BENCH, 'public', 'reports', rid)
    os.makedirs(od, exist_ok=True)
    json.dump(out, open(os.path.join(od, 'summary.json'), 'w'), ensure_ascii=False, indent=1)
    page = os.path.join(od, 'index.html')
    if os.path.exists(page):
        s = open(page).read()
        blob = json.dumps(out, ensure_ascii=False).replace('</', '<\\/')
        s2 = re.sub(r'(<script type="application/json" id="round-data">)(.*?)(</script>)', lambda m: m.group(1) + blob + m.group(3), s, flags=re.S)
        if s2 != s:
            open(page, 'w').write(s2)
    for k, v in totals.items():
        print(k, {m: v[m] for m in ('quality', 'speed', 'cost', 'seconds', 'cost_usd', 'complete')})
    for t, e in tasks.items():
        print(t, {k: (x['status'], x.get('quality'), x.get('speed'), x.get('cost')) for k, x in e['tools'].items()})
    # 这一轮的成绩变了，总览的数据跟着更新
    import build_overview
    build_overview.main()


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'round-01')
