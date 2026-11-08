#!/usr/bin/env python3
"""正式轮（11-08 定）：27 道题 × 两家，一家一家顺序跑；按题交替，每题 Claude Code 先跑、Codex 后跑。
用法：python3 runner/schedule_formal.py [批次名]        默认批次 2026-11-08-formal
      python3 runner/schedule_formal.py --check          只做开跑前检查（题面、底稿、判分程序、两家版本、磁盘），不跑

- S2、F1、B2、R9 沿用 11-08 xhigh 结果，不在这里跑。题目按维度轮流排（修 bug / 守规矩 / 后端 / 前端），先排跑过的样题
- 每次运行前：清测评用户的 /tmp，停掉上一次留下的本地服务和进程，关模拟器并卸掉装进去的 App
  （后跑的一家看不到先跑那家装的 App），磁盘剩不到 8 GB 先清测评用户的 DerivedData
- 跑完：非前端题由 run.py 当场判分；前端题接着回放录屏判分，再关模拟器
- 撞到用量上限（Claude Code 走订阅、Codex 走 ChatGPT 额度）或接口出错中断：这次挪到 <工具>-void-<时分秒> 作废，
  这家暂停到额度恢复（解析提示里的时间，解析不出等 30 分钟），另一家照跑，恢复后这题从头重跑。
  出错中断同一题同一家最多重试 2 次；用量上限连续撞 6 次就停掉这家，等人处理
- 已经判完分的跳过（中途停了重新起能续跑）
- 进度写 runs/<批次>/progress.json，日志 runs/<批次>/schedule.log
"""
import datetime, hashlib, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config  # noqa: E402
from run import ae  # noqa: E402

ORDER = ['S1', 'R5', 'B4', 'F2',
         'S3', 'R1', 'B1', 'F3',
         'S4', 'R2', 'B3', 'F4',
         'S5', 'R3', 'B5', 'F5',
         'T1', 'R4', 'F6',
         'T2', 'R6', 'T3', 'R7', 'T4', 'R8', 'P1', 'R10']
TOOLS = ['claude', 'codex']
MIN_FREE_GB = 8
STOP_FREE_GB = 4
MAX_ERROR_RETRY = 2
MAX_LIMIT_HITS = 6


def now():
    return datetime.datetime.now().strftime('%m-%d %H:%M:%S')


def log(msg):
    print(f'[{now()}] {msg}', flush=True)


def free_gb():
    return shutil.disk_usage('/').free / 2**30


def check():
    ok = True
    for t in ORDER:
        if not os.path.exists(os.path.join(config.TASKS, t, 'prompt.md')):
            log(f'缺题面：{t}'); ok = False
        if ae(f'test -d ~/tasks/{t}-base').returncode:
            log(f'缺底稿：{t}-base'); ok = False
        has = ae(f"grep -q 'def grade_{t.lower()}(' ~/tasks/grade_task.py || test -f ~/tasks/grade_{t.lower()}.py").returncode == 0
        if not has:
            log(f'缺判分程序：{t}'); ok = False
    # 测评用户里部署的判分程序要和仓库里的一致
    for f in sorted(os.listdir(HERE)):
        if f.startswith('grade_') and f.endswith('.py'):
            mine = hashlib.md5(open(os.path.join(HERE, f), 'rb').read()).hexdigest()
            theirs = ae(f'md5 -q ~/tasks/{f} 2>/dev/null').stdout.strip()
            if mine != theirs:
                log(f'测评用户里的 {f} 和仓库不一致'); ok = False
    v = ae('claude --version; codex --version').stdout.split('\n')
    log(f'版本：{" / ".join(x for x in v if x)}；磁盘剩 {free_gb():.1f} GB')
    return ok


def sweep():
    """两次运行之间：停掉测评用户留下的进程（本地服务、构建、工具本身），关模拟器、卸掉装进去的 App，清 /tmp"""
    ae(f"pkill -9 -u {config.USER} -f '[w]rangler|[w]orkerd|[v]itest|[v]ite|[n]ode|[n]pm |[n]px |[c]laude|[c]odex|[x]codebuild|[h]ttp.server|[c]affeinate'; true")
    sim = config.SIMULATOR
    if sim:
        apps = ae(f'ls ~/Library/Developer/CoreSimulator/Devices/{sim}/data/Containers/Bundle/Application/*/*.app/Info.plist 2>/dev/null').stdout.split()
        bundles = set()
        for p in apps:
            b = ae(f"/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' '{p}'").stdout.strip()
            if b:
                bundles.add(b)
        if bundles:
            ae(f'xcrun simctl boot {sim} 2>/dev/null; xcrun simctl bootstatus {sim} -b >/dev/null', timeout=300)
            for b in sorted(bundles):
                ae(f'xcrun simctl uninstall {sim} {b}', timeout=120)
            log(f'  卸掉模拟器里的 App：{", ".join(sorted(bundles))}')
        ae(f'xcrun simctl shutdown {sim} >/dev/null 2>&1; true', timeout=120)
    subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), 'cleantmp'])
    if free_gb() < MIN_FREE_GB:
        ae('rm -rf ~/Library/Developer/Xcode/DerivedData/*')
        log(f'  磁盘不够，清了测评用户的 DerivedData，现在剩 {free_gb():.1f} GB')
    while free_gb() < STOP_FREE_GB:
        log(f'  磁盘只剩 {free_gb():.1f} GB，暂停，等腾出空间（每 10 分钟看一次）')
        time.sleep(600)


def reset_time(text):
    """从提示里解析额度恢复的时刻；解析不出给 None"""
    m = re.search(r'\|(\d{10})\b', text)
    if m:
        return int(m.group(1))
    m = re.search(r'(?:try again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)', text, re.I)
    if m:
        h = int(m.group(1)) % 12 + (12 if m.group(3).lower().startswith('p') else 0)
        mi = int(m.group(2) or 0)
        n = datetime.datetime.now()
        t = n.replace(hour=h, minute=mi, second=0, microsecond=0)
        if t <= n:
            t += datetime.timedelta(days=1)
        return int(t.timestamp())
    return None


def failure(out, tool):
    """这次运行是不是被额度或接口错误打断了：None = 正常（含碰到 3 小时安全上限）；否则 ('limit' | 'error', 说明)"""
    meta = json.load(open(os.path.join(out, 'meta.json')))
    if meta.get('hit_cap'):
        return None
    events = []
    for line in open(os.path.join(out, 'transcript.jsonl'), errors='replace'):
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    stderr = open(os.path.join(out, 'stderr.log'), errors='replace').read()[-2000:]
    if tool == 'claude':
        res = [e for e in events if e.get('type') == 'result']
        if res and not res[-1].get('is_error') and res[-1].get('subtype') == 'success':
            return None
        text = (str(res[-1].get('result') or '') if res else '') + ' ' + stderr
    else:
        ends = [e for e in events if e.get('type') in ('turn.completed', 'turn.failed')]
        if ends and ends[-1]['type'] == 'turn.completed':
            return None
        msgs = [str(e.get('message') or (e.get('error') or {}).get('message') or '') for e in events if e.get('type') in ('error', 'turn.failed')]
        text = ' '.join(msgs) + ' ' + stderr
    kind = 'limit' if re.search(r'usage limit|limit reached|hit your limit|rate.?limit|\b429\b|quota', text, re.I) else 'error'
    return kind, text.strip()[-400:]


def graded(out, task):
    return os.path.exists(os.path.join(out, 'meta.json')) and os.path.exists(os.path.join(out, 'grade.json'))


def summary(out):
    meta = json.load(open(os.path.join(out, 'meta.json')))
    g = {}
    try:
        g = json.load(open(os.path.join(out, 'grade.json')))
    except Exception:
        pass
    score = g.get('score', g.get('acceptance_score'))
    return {'seconds': meta.get('seconds'), 'cost_usd': meta.get('cost_usd'), 'tool_calls': meta.get('tool_calls'),
            'score': score, 'hit_cap': meta.get('hit_cap'), 'danger': meta.get('danger')}


def main(batch):
    root = os.path.join(config.RUNS, batch)
    os.makedirs(root, exist_ok=True)
    queue = [(t, k) for t in ORDER for k in TOOLS]
    blocked = {k: 0 for k in TOOLS}
    limit_hits = {k: 0 for k in TOOLS}
    errors = {}
    stopped = set()
    done = []
    voids = []

    def save(current=None):
        json.dump({'batch': batch, 'updated': now(), 'current': current, 'done': done, 'voids': voids,
                   'blocked_until': {k: (datetime.datetime.fromtimestamp(v).strftime('%m-%d %H:%M') if v > time.time() else None) for k, v in blocked.items()},
                   'stopped': sorted(stopped), 'left': [f'{t}-{k}' for t, k in queue]},
                  open(os.path.join(root, 'progress.json'), 'w'), ensure_ascii=False, indent=1)

    log(f'开跑：批次 {batch}，{len(queue)} 次运行')
    while queue:
        ready = [(t, k) for t, k in queue if k not in stopped and blocked[k] <= time.time()]
        if not ready:
            live = [blocked[k] for k in TOOLS if k not in stopped and any(q[1] == k for q in queue)]
            if not live:
                log('剩下的都停了，等人处理：' + ', '.join(f'{t}-{k}' for t, k in queue))
                break
            wake = min(live)
            log(f'两家都在等额度，睡到 {datetime.datetime.fromtimestamp(wake).strftime("%H:%M")}')
            save()
            time.sleep(max(60, wake - time.time()))
            continue
        task, tool = ready[0]
        out = os.path.join(root, task, tool)
        if graded(out, task):
            queue.remove((task, tool))
            done.append({'task': task, 'tool': tool, **summary(out)})
            log(f'{task}-{tool} 已判过，跳过')
            continue
        if os.path.exists(os.path.join(out, 'meta.json')) and not failure(out, tool):  # 跑完了但没判分（中途停在判分前）：只补判
            log(f'{task}-{tool} 跑完没判分，补判')
            subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), 'grade', task, tool, batch])
            if task.startswith('F'):
                subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), 'simoff'])
            if graded(out, task):
                continue
        if os.path.isdir(out):  # 上次跑到一半就停了：作废重跑
            shutil.move(out, f'{out}-void-{datetime.datetime.now().strftime("%H%M%S")}')
        sweep()
        save(f'{task}-{tool}')
        log(f'▶ {task}-{tool} 开始')
        r = subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), task, tool, batch], capture_output=True, text=True)
        log('  ' + (r.stdout.strip() + ' ' + r.stderr.strip()[-800:]).strip().replace('\n', '\n  '))
        if not os.path.exists(os.path.join(out, 'meta.json')):
            errors[(task, tool)] = errors.get((task, tool), 0) + 1
            log(f'  ✗ {task}-{tool} 没跑起来（第 {errors[(task, tool)]} 次）')
            if errors[(task, tool)] > MAX_ERROR_RETRY:
                queue.remove((task, tool))
                voids.append({'task': task, 'tool': tool, 'kind': 'crash', 'note': r.stderr.strip()[-300:]})
            else:
                blocked[tool] = time.time() + 600
            continue
        f = failure(out, tool)
        if f:
            kind, note = f
            dst = f'{out}-void-{kind}-{datetime.datetime.now().strftime("%H%M%S")}'
            shutil.move(out, dst)
            voids.append({'task': task, 'tool': tool, 'kind': kind, 'note': note, 'at': now(), 'dir': os.path.basename(dst)})
            if kind == 'limit':
                limit_hits[tool] += 1
                t = reset_time(note)
                blocked[tool] = (t + 120) if t and time.time() < t < time.time() + 8 * 3600 else time.time() + 1800
                log(f'  ⏸ {task}-{tool} 撞到用量上限，作废；这家暂停到 {datetime.datetime.fromtimestamp(blocked[tool]).strftime("%m-%d %H:%M")}。提示：{note[-200:]}')
                if limit_hits[tool] >= MAX_LIMIT_HITS:
                    stopped.add(tool)
                    log(f'  ■ {tool} 连续撞上限 {MAX_LIMIT_HITS} 次，停掉这家，等人处理')
            else:
                errors[(task, tool)] = errors.get((task, tool), 0) + 1
                log(f'  ✗ {task}-{tool} 接口出错中断（第 {errors[(task, tool)]} 次），作废：{note[-200:]}')
                if errors[(task, tool)] > MAX_ERROR_RETRY:
                    queue.remove((task, tool))
                    log(f'  ■ {task}-{tool} 重试 {MAX_ERROR_RETRY} 次都出错，放弃这题')
                else:
                    blocked[tool] = time.time() + 600
            save()
            continue
        limit_hits[tool] = 0
        if task.startswith('F'):
            g = subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), 'grade', task, tool, batch], capture_output=True, text=True)
            log('  ' + (g.stdout.strip() + ' ' + g.stderr.strip()[-600:]).strip().replace('\n', '\n  '))
            subprocess.run([sys.executable, os.path.join(HERE, 'run.py'), 'simoff'])
        queue.remove((task, tool))
        s = summary(out)
        done.append({'task': task, 'tool': tool, **s})
        cost = f'{s["cost_usd"]:.2f} 美元' if isinstance(s['cost_usd'], (int, float)) else '花费另算'
        log(f'✓ {task}-{tool} 完成：{(s["seconds"] or 0) // 60} 分 {(s["seconds"] or 0) % 60} 秒，{cost}，{s["tool_calls"]} 次工具调用，'
            f'判分 {s["score"]}{"，碰到 3 小时上限" if s["hit_cap"] else ""}{"，危险操作：" + "；".join(s["danger"]) if s["danger"] else ""}')
        save()
    sweep()
    save()
    log(f'全部结束：完成 {len(done)} 次，作废 {len(voids)} 次，剩 {len(queue)} 次')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    # --tasks=B4,F2：只跑这几题（11-08 定第一轮先出精简版，正式题库照旧 31 道）
    for a in sys.argv[1:]:
        if a.startswith('--tasks='):
            ORDER[:] = [t for t in a.split('=', 1)[1].split(',') if t]
        # --tools=claude：只跑这几家（11-08 定先只跑 Claude Code，跑完再商量 Codex 什么时候跑）
        if a.startswith('--tools='):
            TOOLS[:] = [k for k in a.split('=', 1)[1].split(',') if k]
    if '--check' in sys.argv:
        sys.exit(0 if check() else 1)
    if not check():
        log('开跑前检查没过，不跑')
        sys.exit(1)
    main(args[0] if args else '2026-11-08-formal')
