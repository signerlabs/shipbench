#!/usr/bin/env python3
"""在测评用户里给一次运行判分：python3 grade_task.py <题号> <工作目录> <输出目录>

题号：S1（Swift 包修 bug，隐藏测试）、B4（Workers + D1 后端，接口验收）、R5（守规矩，静态检查 + 编译）、
F2（前端复现，只做编译、安装、回放录屏和截图；相似度另由 f2_score.py 算）。
判分一律在工作目录的副本里做，不动工具留下的现场。结果写 <输出目录>/grade.json。
"""
import json, os, re, shutil, subprocess, sys, time

TASKS = os.path.expanduser('~/tasks')
SIM = os.environ.get('SHIPBENCH_SIMULATOR', '')  # 测评用户自己的模拟器 UDID，由 run.py 传进来


def sh(cmd, cwd=None, timeout=1800):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr, time.time() - t
    except subprocess.TimeoutExpired as e:
        return 124, str(e.stdout or '') + '\n[判分超时]', time.time() - t


def copy_ws(ws, out, name):
    dst = os.path.join(out, name)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(ws, dst, symlinks=True, ignore=shutil.ignore_patterns('.build', 'DerivedData', '.wrangler'))
    return dst


def added_lines(ws, paths='.', exclude=()):
    """相对基线提交新增的行（含没提交的改动和新文件）"""
    sh('git add -A', cwd=ws)
    ex = ' '.join(f"':(exclude){e}'" for e in exclude)
    _, diff, _ = sh(f"git diff --cached agenteval-base -- {paths} {ex}", cwd=ws)
    return [l[1:] for l in diff.splitlines() if l.startswith('+') and not l.startswith('+++')]


def grade_s1(ws, out):
    g = copy_ws(ws, out, 'grade-ws')
    shutil.copy(os.path.join(TASKS, 'S1-hidden/CloudMergeTests.swift'), os.path.join(g, 'Tests/ClipDataTests/CloudMergeTests.swift'))
    code, log, dt = sh('swift test 2>&1', cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-swift-test.log'), 'w').write(log)
    target = re.search(r'Test keeperChoiceIgnoresSubSecondDifferences\(\) passed', log) is not None
    m = re.search(r'Test run with (\d+) tests? in \d+ suites? (passed|failed)', log)
    total = int(m.group(1)) if m else None
    fails = re.findall(r'✘ Test (\w+)\(\) (?:failed|recorded an issue)', log)
    fails = sorted(set(fails))
    all_pass = code == 0 and m is not None and m.group(2) == 'passed'
    score = 100 if (target and all_pass) else (50 if target else 0)
    return {'score': score, 'checks': [
        {'name': '隐藏测试 keeperChoiceIgnoresSubSecondDifferences 通过', 'ok': target},
        {'name': '全部测试通过（没有改坏别的）', 'ok': all_pass},
    ], 'tests_total': total, 'failed_tests': fails, 'seconds': round(dt)}


def grade_b4(ws, out):
    g = copy_ws(ws, out, 'grade-ws')
    if not os.path.exists(os.path.join(g, 'node_modules')):
        sh('npm install --no-audit --no-fund 2>&1', cwd=g, timeout=600)
    code, log, dt = sh(f"node {TASKS}/grade.mjs {out}/grade-b4.json 2>&1", cwd=g, timeout=900)
    open(os.path.join(out, 'grade-b4.log'), 'w').write(log)
    try:
        r = json.load(open(os.path.join(out, 'grade-b4.json')))
    except Exception:
        return {'score': 0, 'checks': [{'name': '验收脚本跑通', 'ok': False}], 'log': log[-800:]}
    return {'score': r['score'], 'checks': [{'name': c['name'], 'ok': c['ok']} for c in r['cases']],
            'setup': {k: v for k, v in r['setup'].items() if k != 'migrate'}, 'seconds': round(dt)}


def strip_previews(src):
    """去掉 #Preview { … } 块：预览里挂 .swAlert() 等不算 App 运行时的代码（组件文档自己的预览也这么写）"""
    out, i = [], 0
    while True:
        j = src.find('#Preview', i)
        if j < 0:
            out.append(src[i:])
            return ''.join(out)
        out.append(src[i:j])
        k = src.find('{', j)
        if k < 0:
            return ''.join(out)
        depth, n = 0, k
        while n < len(src):
            if src[n] == '{':
                depth += 1
            elif src[n] == '}':
                depth -= 1
                if depth == 0:
                    break
            n += 1
        i = n + 1


def grade_r5(ws, out):
    app = ':(exclude)Sprout/ShipSwift'
    sh('git add -A', cwd=ws)
    code, files, _ = sh("git ls-files 'Sprout/*.swift' ':(exclude)Sprout/ShipSwift'", cwd=ws)
    src = {f: strip_previews(open(os.path.join(ws, f), errors='ignore').read()) for f in files.split() if os.path.exists(os.path.join(ws, f))}
    allsrc = '\n'.join(src.values())
    add = '\n'.join(added_lines(ws, 'Sprout', exclude=('Sprout/ShipSwift',)))
    swalert = {f: s.count('.swAlert()') for f, s in src.items() if '.swAlert()' in s}
    _, ss_diff, _ = sh('git diff --cached --stat agenteval-base -- Sprout/ShipSwift', cwd=ws)
    _, pbx_diff, _ = sh('git diff --cached --stat agenteval-base -- Sprout.xcodeproj/project.pbxproj', cwd=ws)
    g = copy_ws(ws, out, 'grade-ws')
    bcode, blog, dt = sh(f"xcodebuild -project Sprout.xcodeproj -scheme Sprout -destination 'generic/platform=iOS Simulator' -derivedDataPath {out}/grade-dd build 2>&1", cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-build.log'), 'w').write(blog[-20000:])
    shutil.rmtree(f'{out}/grade-dd', ignore_errors=True)
    build_ok = bcode == 0 and '** BUILD SUCCEEDED **' in blog
    checks = [
        {'name': '成功提示用组件：SWAlertManager .show(.success …)', 'ok': '.show(.success' in allsrc},
        {'name': '失败提示用组件：SWAlertManager .show(.error …)', 'ok': '.show(.error' in allsrc},
        {'name': '.swAlert() 只挂一处，挂在 App 入口 SproutApp.swift', 'ok': sum(swalert.values()) == 1 and 'Sprout/SproutApp.swift' in swalert},
        {'name': '不用延时（asyncAfter / Task.sleep）等弹层关掉', 'ok': not re.search(r'asyncAfter|Task\.sleep|Thread\.sleep', add)},
        {'name': '不自己写提示条、不用系统 .alert 提示', 'ok': not re.search(r'(struct|class|enum)\s+\w*(Toast|Banner|Snackbar|Hud|HUD)\w*', add) and '.alert(' not in add},
        {'name': '编辑页用 sheet 弹出', 'ok': '.sheet(' in add},
        {'name': '不写 iOS 18 及以下的兼容分支', 'ok': not re.search(r'[#@]available\s*\(\s*iOS\s*1[0-8]', add)},
        {'name': '没改 ShipSwift 组件源码', 'ok': ss_diff.strip() == ''},
        {'name': '没改工程文件（构建设置、依赖）', 'ok': pbx_diff.strip() == ''},
    ]
    passed = sum(c['ok'] for c in checks)
    score = round(passed / len(checks) * 100) if build_ok else 0
    return {'score': score, 'build_ok': build_ok, 'checks': [{'name': '编译通过（不过则本题 0 分）', 'ok': build_ok}] + checks,
            'swAlert_sites': swalert, 'seconds': round(dt)}


def grade_f2(ws, out, name):
    g = copy_ws(ws, out, 'grade-ws')
    dd = f'{out}/grade-dd'
    bcode, blog, dt = sh(f"xcodebuild -project Replica.xcodeproj -scheme Replica -configuration Release -destination 'platform=iOS Simulator,id={SIM}' -derivedDataPath {dd} build 2>&1", cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-build.log'), 'w').write(blog[-20000:])
    build_ok = bcode == 0 and '** BUILD SUCCEEDED **' in blog
    res = {'build_ok': build_ok, 'seconds': round(dt)}
    if not build_ok:
        res['score'] = 0
        return res
    appdir = f'{dd}/Build/Products/Release-iphonesimulator'
    apps = [a for a in os.listdir(appdir) if a.endswith('.app')]
    app = os.path.join(appdir, apps[0])
    bundle = subprocess.run(['/usr/libexec/PlistBuddy', '-c', 'Print CFBundleIdentifier', f'{app}/Info.plist'], capture_output=True, text=True).stdout.strip()
    res['bundle'] = bundle
    sh(f'xcrun simctl boot {SIM}; xcrun simctl bootstatus {SIM} -b', timeout=300)
    sh(f'xcrun simctl uninstall {SIM} {bundle}')
    icode, ilog, _ = sh(f'xcrun simctl install {SIM} "{app}"')
    res['install_ok'] = icode == 0
    shots = os.path.expanduser(f'~/rec/shots/{name}')
    if os.path.exists(shots):
        shutil.rmtree(shots)
    os.makedirs(shots)
    script = open(os.path.join(TASKS, 'f2-play.json')).read().replace('BUNDLE', bundle).replace('ARGS', '[]').replace('SHOTS', shots)
    open(os.path.expanduser(f'~/rec/f2-{name}.json'), 'w').write(script)
    rcode, rlog, _ = sh(f'cd ~/rec && ./record.sh f2-{name}.json f2-{name}-raw', timeout=600)
    res['record_log'] = rlog[-600:]
    for f in [f'f2-{name}-raw.mp4', f'f2-{name}-raw.marks']:
        p = os.path.expanduser(f'~/rec/{f}')
        if os.path.exists(p):
            shutil.copy(p, out)
    res['shots'] = sorted(os.listdir(shots))
    shutil.copytree(shots, os.path.join(out, 'shots'), dirs_exist_ok=True)
    shutil.rmtree(dd, ignore_errors=True)
    return res


if __name__ == '__main__':
    task, ws, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    if task == 'S1':
        r = grade_s1(ws, out)
    elif task == 'B4':
        r = grade_b4(ws, out)
    elif task == 'R5':
        r = grade_r5(ws, out)
    elif task == 'F2':
        r = grade_f2(ws, out, sys.argv[4] if len(sys.argv) > 4 else 'replica')
    else:
        # 新题的判分各自一个模块：grade_<题号小写>.py，和本文件放在一起，提供 grade(ws, out, name)
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        try:
            import importlib
            mod = importlib.import_module(f'grade_{task.lower()}')
        except ModuleNotFoundError:
            sys.exit(f'不认识的题号 {task}')
        r = mod.grade(ws, out, sys.argv[4] if len(sys.argv) > 4 else 'replica')
    shutil.rmtree(os.path.join(out, 'grade-ws'), ignore_errors=True)
    json.dump(r, open(os.path.join(out, 'grade.json'), 'w'), ensure_ascii=False, indent=2)
    print(json.dumps({k: v for k, v in r.items() if k in ('score', 'build_ok')}, ensure_ascii=False))
