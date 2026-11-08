#!/usr/bin/env python3
"""TypeScript 服务端题（T1、T3、T4）的共用判分：复制工作目录，往 tests/ 里放隐藏测试文件，跑 vitest。

- 每题的隐藏用例分两种：目标用例（考这次要修的行为）和守门用例（正常情况照旧，防止改过头）。
- 分数 = 目标用例通过数 / 目标用例数 × 100。
- 「没改坏别的」：守门用例全过、其余测试全过、底稿原有测试一条不少；不满足则分数减半。
- 「补了测试」只记录，不计分。
"""
import json, os, shutil
from grade_task import sh, TASKS


def _results(path):
    """vitest JSON 报告 → {(文件名, 标题链): 状态}，以及加载失败的测试文件"""
    r = json.load(open(path))
    names, broken = {}, []
    for tr in r.get('testResults', []):
        f = os.path.basename(tr['name'])
        if tr.get('status') != 'passed' and not tr.get('assertionResults'):
            broken.append(f)
        for a in tr.get('assertionResults', []):
            names[f + ' > ' + ' > '.join(a.get('ancestorTitles', []) + [a['title']])] = a['status']
    return names, broken


def grade_vitest(ws, out, task, hidden_file, cases):
    """cases: [(用例标题, 中文说明, 是否守门)]"""
    g = os.path.join(out, 'grade-ws')
    if os.path.exists(g):
        shutil.rmtree(g)
    shutil.copytree(ws, g, symlinks=True, ignore=shutil.ignore_patterns('node_modules', '.wrangler', 'dist'))
    nm = os.path.join(ws, 'node_modules')
    os.symlink(nm if os.path.isdir(nm) else os.path.join(TASKS, f'{task}-base', 'node_modules'), os.path.join(g, 'node_modules'))
    hd = os.path.join(TASKS, f'{task}-hidden')
    base_tests = set(json.load(open(os.path.join(hd, 'base-tests.json'))))
    shutil.copy(os.path.join(hd, hidden_file), os.path.join(g, 'tests', hidden_file))
    rep = os.path.join(out, 'grade-vitest.json')
    if os.path.exists(rep):
        os.remove(rep)
    code, log, dt = sh(f'npx vitest run --reporter=default --reporter=json --outputFile.json={rep} 2>&1', cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-vitest.log'), 'w').write(log)
    built = os.path.exists(rep)
    names, broken = _results(rep) if built else ({}, [])
    checks, targets, guards_ok = [], [], True
    for title, label, guard in cases:
        hits = [s for n, s in names.items() if n.startswith(hidden_file + ' > ') and n.endswith(' > ' + title)]
        ok = built and len(hits) == 1 and hits[0] == 'passed'
        checks.append({'name': ('守门｜' if guard else '') + label, 'ok': ok})
        if guard:
            guards_ok = guards_ok and ok
        else:
            targets.append(ok)
    own = {n for n in names if not n.startswith(hidden_file + ' > ')}
    other_fail = sorted(n for n in own if names[n] == 'failed') + sorted(f + '（文件没能加载）' for f in broken if f != hidden_file)
    missing = sorted(base_tests - own)
    no_regress = built and guards_ok and not other_fail and not missing
    score = round(sum(targets) / len(targets) * 100) if built else 0
    if not no_regress:
        score = score // 2
    added = sorted(own - base_tests)
    checks.append({'name': '没改坏别的：守门用例与其余测试全过、底稿原有测试一条不少（不满足分数减半）', 'ok': no_regress})
    checks.append({'name': '补了测试（只记录、不计分）', 'ok': bool(added), 'info': True})
    return {'score': score, 'build_ok': built, 'checks': checks, 'other_failed': other_fail, 'missing_base_tests': missing,
            'added_tests': added, 'hidden_file_loaded': hidden_file not in broken, 'seconds': round(dt)}
