#!/usr/bin/env python3
"""F1 判分（在测评用户里跑，由 grade_task.py 按题号调用）：烟火小店引导页复现。
和 F2 一样只做编译、安装、按 ~/tasks/f1-play.json 回放录屏和截图（k1–k3）；相似度另由 f2_score.py（FTASK=F1）算，盲评看并排录屏。"""
import os, shutil, subprocess
from grade_task import sh, copy_ws, TASKS, SIM


def grade(ws, out, name='replica'):
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
    app = os.path.join(appdir, [a for a in os.listdir(appdir) if a.endswith('.app')][0])
    bundle = subprocess.run(['/usr/libexec/PlistBuddy', '-c', 'Print CFBundleIdentifier', f'{app}/Info.plist'], capture_output=True, text=True).stdout.strip()
    res['bundle'] = bundle
    sh(f'xcrun simctl boot {SIM}; xcrun simctl bootstatus {SIM} -b', timeout=300)
    sh(f'xcrun simctl uninstall {SIM} {bundle}')
    icode, _, _ = sh(f'xcrun simctl install {SIM} "{app}"')
    res['install_ok'] = icode == 0
    shots = os.path.expanduser(f'~/rec/shots/f1-{name}')
    shutil.rmtree(shots, ignore_errors=True)
    os.makedirs(shots)
    script = open(os.path.join(TASKS, 'f1-play.json')).read().replace('BUNDLE', bundle).replace('ARGS', '[]').replace('SHOTS', shots)
    open(os.path.expanduser(f'~/rec/f1-{name}.json'), 'w').write(script)
    _, rlog, _ = sh(f'cd ~/rec && ./record.sh f1-{name}.json f1-{name}-raw', timeout=600)
    res['record_log'] = rlog[-600:]
    for f in [f'f1-{name}-raw.mp4', f'f1-{name}-raw.marks']:
        p = os.path.expanduser(f'~/rec/{f}')
        if os.path.exists(p):
            shutil.copy(p, out)
    res['shots'] = sorted(os.listdir(shots))
    shutil.copytree(shots, os.path.join(out, 'shots'), dirs_exist_ok=True)
    shutil.rmtree(dd, ignore_errors=True)
    return res
