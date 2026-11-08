#!/usr/bin/env python3
"""S2 判分（在测评用户里跑，由 grade_task.py 按题号调用）：剪贴板数据层两处 bug（搜索翻页锚点、Pinboard 排序键相撞）。

做法：复制工作目录，只往测试目录里加一个隐藏测试文件（helper 都带 hidden 前缀，不覆盖工具自己的测试文件，免得撞名），跑 swift test。
- 8 个隐藏用例（参数化的按每个参数算一个），分数 = 通过数 / 8 × 100。
- 「没改坏别的」：除隐藏用例外全部测试通过，且底稿原有的 38 条测试一条不少；不满足则分数减半。
- 「补了复现测试」只记录，不计分。
"""
import os, re, shutil
from grade_task import sh, copy_ws, TASKS

HIDDEN = os.path.join(TASKS, 'S2-hidden')
CASES = [
    ('hiddenSearchAnchorDeleted', 'needle → "note"', '搜索翻页｜锚点被删后下一页接着往下（长搜索词，全文索引）'),
    ('hiddenSearchAnchorDeleted', 'needle → "no"', '搜索翻页｜锚点被删后下一页接着往下（两个字的短搜索词）'),
    ('hiddenSearchAnchorUsed', 'needle → "note"', '搜索翻页｜锚点被取用（移到最前）后不回到开头（长搜索词）'),
    ('hiddenSearchAnchorUsed', 'needle → "ot"', '搜索翻页｜锚点被取用后不回到开头（短搜索词）'),
    ('hiddenSearchFullScanWhileChanging', 'deleteAnchor → false', '搜索翻页｜边翻边取用，翻到底不重不漏'),
    ('hiddenSearchFullScanWhileChanging', 'deleteAnchor → true', '搜索翻页｜边翻边删，翻到底不重不漏'),
    ('hiddenEqualSortKeysOrderedAndMovable', None, 'Pinboard 排序｜三个排序键相同：顺序固定、拖得动'),
    ('hiddenEqualSortKeysFourBoardsMoveFar', None, 'Pinboard 排序｜四个排序键相同：跨两三格拖动都到位'),
]


def test_names(root):
    names = set()
    for dp, _, fs in os.walk(os.path.join(root, 'Tests')):
        for f in fs:
            if f.endswith('.swift'):
                names |= set(re.findall(r'@Test(?:\([^)]*\))?\s+func\s+(\w+)', open(os.path.join(dp, f), errors='ignore').read()))
    return names


def grade(ws, out, name=None):
    g = copy_ws(ws, out, 'grade-ws')
    base_tests = set(open(os.path.join(HIDDEN, 'base-tests.txt')).read().split())
    own = test_names(g)
    tdir = os.path.join(g, 'Tests', 'ClipDataTests')
    os.makedirs(tdir, exist_ok=True)
    shutil.copy(os.path.join(HIDDEN, 'HiddenRegressionTests.swift'), tdir)
    code, log, dt = sh('swift test 2>&1', cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-swift-test.log'), 'w').write(log)
    built = re.search(r'Test run with \d+ tests?', log) is not None
    issues = [l for l in log.splitlines() if 'recorded an issue' in l]
    started = set(re.findall(r'Test (hidden\w+)\(', log))
    checks = []
    for fn, arg, label in CASES:
        bad = [l for l in issues if f'Test {fn}(' in l and (arg is None or arg in l)]
        ok = built and fn in started and not bad and not re.search(rf'Test {fn}\([^)]*\)[^\n]*(crash|terminated|Fatal)', log)
        checks.append({'name': label, 'ok': ok})
    passed = sum(c['ok'] for c in checks)
    other_fail = sorted(set(re.findall(r'Test (\w+)\([^)]*\) (?:with \d+ test cases )?failed', log)) - {c[0] for c in CASES})
    missing = sorted(base_tests - own)
    no_regress = built and not other_fail and not missing
    score = round(passed / len(CASES) * 100) if built else 0
    if not no_regress:
        score = score // 2
    added = sorted(own - base_tests)
    checks.append({'name': '没改坏别的：其余测试全过、底稿原有测试一条不少（不满足分数减半）', 'ok': no_regress})
    checks.append({'name': '补了复现测试（只记录、不计分）', 'ok': bool(added), 'info': True})
    return {'score': score, 'build_ok': built, 'checks': checks, 'other_failed': other_fail, 'missing_base_tests': missing,
            'added_tests': added, 'seconds': round(dt)}
