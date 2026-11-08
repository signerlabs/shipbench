#!/usr/bin/env python3
"""iOS App 修 bug 题（S3、S4）的共用判分：复制工作目录，往单元测试目录 PetBookTests/ 放一个隐藏测试文件，
在测评用户自己的模拟器上跑 xcodebuild test（不并行），从结果包读每个用例的结果，最后关掉模拟器。

- 每题的隐藏用例分目标用例和守门用例。分数 = 目标用例通过数 / 目标用例数 × 100。
- 「没改坏别的」：守门用例与其余测试全过，且底稿原有测试一条不少；不满足则分数减半。编不过记 0 分。
- 「补了测试」只记录，不计分。
"""
import json, os, re, shutil
from grade_task import sh, copy_ws, TASKS, SIM


def test_names(root):
    names = set()
    for dp, _, fs in os.walk(os.path.join(root, 'PetBookTests')):
        for f in fs:
            if f.endswith('.swift'):
                src = open(os.path.join(dp, f), errors='ignore').read()
                names |= set(re.findall(r'@Test(?:\([^)]*\))?\s+func\s+(\w+)', src))
                names |= set(re.findall(r'func\s+(test\w+)\s*\(', src))
    return names


def results(xcresult, log):
    """用例名 → Passed / Failed / …；先读结果包，读不到再从日志里找"""
    out = {}
    code, js, _ = sh(f'xcrun xcresulttool get test-results tests --path "{xcresult}" --format json', timeout=300)
    if code == 0:
        try:
            def walk(n):
                if n.get('nodeType') == 'Test Case':
                    name = re.sub(r'\(.*\)$', '', n.get('name', ''))
                    r = n.get('result') or 'Failed'
                    out[name] = r if out.get(name, 'Passed') == 'Passed' else out[name]   # 同名多次（参数化）：有一次没过就算没过
                for c in n.get('children', []) or []:
                    walk(c)
            for n in json.loads(js).get('testNodes', []):
                walk(n)
        except Exception:
            out = {}
    if not out:
        for m in re.finditer(r"Test case '[^/']*/(\w+)\(\)' (passed|failed)", log):
            out[m.group(1)] = 'Passed' if m.group(2) == 'passed' and out.get(m.group(1), 'Passed') == 'Passed' else 'Failed'
    return out


def grade_ios(ws, out, task, hidden_file, cases):
    g = copy_ws(ws, out, 'grade-ws')
    hd = os.path.join(TASKS, f'{task}-hidden')
    base_tests = set(json.load(open(os.path.join(hd, 'base-tests.json'))))
    own = test_names(g)
    os.makedirs(os.path.join(g, 'PetBookTests'), exist_ok=True)
    shutil.copy(os.path.join(hd, hidden_file), os.path.join(g, 'PetBookTests', hidden_file))
    dd, xr = os.path.join(out, 'grade-dd'), os.path.join(out, 'grade.xcresult')
    for p in (dd, xr):
        shutil.rmtree(p, ignore_errors=True)
    dest = f'id={SIM}' if SIM else 'name=iPhone 18 Pro Max'
    code, log, dt = sh(f"xcodebuild test -project PetBook.xcodeproj -scheme PetBook -destination 'platform=iOS Simulator,{dest}' "
                       f"-derivedDataPath {dd} -resultBundlePath {xr} -parallel-testing-enabled NO 2>&1", cwd=g, timeout=2700)
    open(os.path.join(out, 'grade-xcodebuild.log'), 'w').write(log[-60000:])
    names = results(xr, log)
    built = bool(names) and '** TEST BUILD FAILED **' not in log and 'BUILD FAILED' not in log
    if SIM:
        sh(f'xcrun simctl shutdown {SIM}', timeout=120)
    shutil.rmtree(dd, ignore_errors=True)
    shutil.rmtree(xr, ignore_errors=True)
    checks, targets, guards_ok = [], [], True
    hidden_names = {c[0] for c in cases}
    for fn, label, guard in cases:
        ok = built and names.get(fn) == 'Passed'
        checks.append({'name': ('守门｜' if guard else '') + label, 'ok': ok})
        if guard:
            guards_ok = guards_ok and ok
        else:
            targets.append(ok)
    other_fail = sorted(n for n, r in names.items() if n not in hidden_names and r not in ('Passed', 'Skipped', 'Expected Failure'))
    missing = sorted(base_tests - own)
    no_regress = built and guards_ok and not other_fail and not missing
    score = round(sum(targets) / len(targets) * 100) if built else 0
    if not no_regress:
        score = score // 2
    added = sorted(own - base_tests)
    checks.insert(0, {'name': '编译通过、测试跑起来了（不过则本题 0 分）', 'ok': built})
    checks.append({'name': '没改坏别的：守门用例与其余测试全过、底稿原有测试一条不少（不满足分数减半）', 'ok': no_regress})
    checks.append({'name': '补了测试（只记录、不计分）', 'ok': bool(added), 'info': True})
    return {'score': score, 'build_ok': built, 'checks': checks, 'other_failed': other_fail, 'missing_base_tests': missing,
            'added_tests': added, 'results': names, 'seconds': round(dt)}
