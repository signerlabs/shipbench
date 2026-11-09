#!/usr/bin/env python3
"""汇总所有轮次，更新总览页的数据：python3 tools/build_overview.py

读 rounds/round-*.json（每轮的配置、报告链接、一句话结论）和 public/reports/<轮>/summary.json（build_round.py 生成的成绩），
再读 public/tasks/README.md（31 道题的清单），合成一份数据，写到 public/overview/data.json，
并填进 public/overview/index.html 里的 <script type="application/json" id="overview-data"> 块（页面从这里读数据，页面本身不用改）。

- 只收全部算完的轮次（每家的 totals.complete 都为真），没算完的跳过并打印提示
- 跨轮比较的单位是「题目集合」：跑的题完全相同的轮次才放在一起比，由页面按 tasks 分组
- build_round.py 跑完会自动调用这里，平时不用单独跑；发布总览 artifact 仍要手动重发
"""
import json, os, re

BENCH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(BENCH, 'public')
ROUNDS_DIR = os.path.join(BENCH, 'rounds')
REPO = 'https://github.com/signerlabs/shipbench'
DIMS = [
    {'key': 'fix', 'prefix': 'STP', 'weight': 0.30, 'zh': '修 bug、加功能', 'en': 'Fix bugs & add features'},
    {'key': 'frontend', 'prefix': 'F', 'weight': 0.25, 'zh': '前端复刻', 'en': 'Rebuild a screen'},
    {'key': 'backend', 'prefix': 'B', 'weight': 0.25, 'zh': '后端搭建', 'en': 'Build a backend'},
    {'key': 'rules', 'prefix': 'R', 'weight': 0.20, 'zh': '守规矩', 'en': 'Follow project rules'},
]
CN_NUM = '零一二三四五六七八九'


def load(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def effort_level(s):
    """从命令行参数里取档位：--effort xhigh、-c model_reasoning_effort="xhigh" 都认"""
    m = re.search(r'\b(xhigh|high|medium|low|max)\b', s or '')
    return m.group(1) if m else (s or '')


def version_number(s):
    """工具自报的版本串只留版本号：2.1.319 (Claude Code)、codex-cli 0.167.0"""
    m = re.search(r'\d+(?:\.\d+)+', s or '')
    return m.group(0) if m else s


def default_label(n):
    zh = CN_NUM[n] if n < 10 else (('' if n < 20 else CN_NUM[n // 10]) + '十' + (CN_NUM[n % 10] if n % 10 else ''))
    return {'zh': f'第{zh}轮', 'en': f'Round {n}'}


def read_bank(used):
    """解析 tasks/README.md 的题目表；used：题号 → 用过它的轮次"""
    tasks = {}
    with open(os.path.join(PUBLIC, 'tasks', 'README.md'), encoding='utf-8') as f:
        for line in f:
            m = re.match(r'^\| \[([A-Z]\d+)\]\(\1\) \| (.*?) \| (.*?) \| (.*?) \|\s*$', line)
            if m:
                tasks[m.group(1)] = {'id': m.group(1), 'en': m.group(2), 'zh': m.group(3), 'rounds': used.get(m.group(1), [])}
    out = []
    for d in DIMS:
        items = sorted((t for t in tasks.values() if t['id'][0] in d['prefix']),
                       key=lambda t: (d['prefix'].index(t['id'][0]), int(t['id'][1:])))
        out.append({'key': d['key'], 'weight': d['weight'], 'zh': d['zh'], 'en': d['en'], 'tasks': items})
    return out


def read_round(rid):
    rd = load(os.path.join(ROUNDS_DIR, f'{rid}.json'))
    path = os.path.join(PUBLIC, 'reports', rid, 'summary.json')
    if not os.path.exists(path):
        return None
    s = load(path)
    if not all(t.get('complete') for t in s['totals'].values()):
        return None
    n = int(rid.split('-')[1])
    order = [t for d in s['dimensions'] for t in d['tasks']]
    entries = []
    for key, tool in s['tools'].items():
        tot = s['totals'][key]
        versions = [s['tasks'][t]['tools'][key].get('version') for t in order]
        entries.append({
            'key': key, 'vendor': key, 'model': tool['model_name'], 'agent': tool['name'],
            'version': version_number(next((v for v in versions if v), None)), 'effort': effort_level(tool.get('effort')),
            'quality': tot['quality'], 'speed': tot['speed'], 'cost': tot['cost'],
            'seconds': tot['seconds'], 'cost_usd': tot['cost_usd'], 'dimensions': tot['dimensions'],
            'tasks': {t: {m: s['tasks'][t]['tools'][key].get(m) for m in ('quality', 'speed', 'cost', 'seconds', 'cost_usd')} for t in order},
        })
    return {
        'id': rid, 'n': n, 'label': rd.get('label') or default_label(n), 'title': s['title'], 'date': s['dates'],
        'headline': rd.get('headline'), 'report_url': rd.get('report_url'), 'data_url': f'{REPO}/tree/main/reports/{rid}',
        'dimensions': s['dimensions'],
        'tasks': [{'id': t, 'dimension': s['tasks'][t]['dimension'], 'level': s['tasks'][t].get('level'),
                   'zh': s['tasks'][t].get('zh'), 'en': s['tasks'][t].get('en'), 'lang': s['tasks'][t].get('lang')} for t in order],
        'entries': entries,
    }


def main():
    ids = sorted(f[:-5] for f in os.listdir(ROUNDS_DIR) if re.fullmatch(r'round-\d+\.json', f))
    rounds = []
    for rid in ids:
        r = read_round(rid)
        if r:
            rounds.append(r)
        else:
            print(f'总览跳过 {rid}：还没算完')
    used = {}
    for r in rounds:
        for t in r['tasks']:
            used.setdefault(t['id'], []).append(r['id'])
    out = {'repo': REPO, 'updated': rounds[-1]['date'] if rounds else None, 'rounds': rounds, 'bank': read_bank(used)}
    od = os.path.join(PUBLIC, 'overview')
    os.makedirs(od, exist_ok=True)
    with open(os.path.join(od, 'data.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    page = os.path.join(od, 'index.html')
    if os.path.exists(page):
        with open(page, encoding='utf-8') as f:
            s = f.read()
        blob = json.dumps(out, ensure_ascii=False).replace('</', '<\\/')
        s2 = re.sub(r'(<script type="application/json" id="overview-data">)(.*?)(</script>)',
                    lambda m: m.group(1) + blob + m.group(3), s, flags=re.S)
        if s2 != s:
            with open(page, 'w', encoding='utf-8') as f:
                f.write(s2)
    total = sum(len(d['tasks']) for d in out['bank'])
    print(f'总览已更新：{len(rounds)} 轮，题库 {total} 道，已跑 {len(used)} 道')


if __name__ == '__main__':
    main()
