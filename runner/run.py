#!/usr/bin/env python3
"""在操作者自己的账户里调度一次运行：python3 run.py <题号> <工具> <批次名>

工具：claude（Claude Code + Opus）、codex（Codex + GPT）、qwen（Qwen Code + 千问，走百炼 OpenAI 兼容接口）。
流程：在测评用户（默认 agenteval，见 config.py）里建一次性工作目录（从 ~/tasks/<题号>-base 复制，git 建基线提交）→
临时注入凭证、全新配置目录 → 限时全自动跑 → 收回凭证 → 收集对话记录、改动、用时、花费 → 危险操作检查 → 判分。
结果写到 <SHIPBENCH_RUNS>/<批次名>/<题号>/<工具>/。
其他命令：run.py grade <题号> <工具> <批次名>（重判）、run.py cleantmp（清测评用户的 /tmp）、run.py simoff（关测评用户的模拟器）。
"""
import json, os, re, shlex, subprocess, sys, time, datetime
import config

AE = config.USER_HOME
LIMIT = {'S1': 20, 'B4': 30, 'R5': 20, 'F2': 30,   # 11-07 样板（偏易）
         'S2': 20, 'B2': 30, 'R9': 20, 'F1': 30}   # 11-07 加难后的样板
# 不设评分限时（11-07 定），各家跑完为止、照实记用时；只留 3 小时安全上限防卡死（碰到记为卡死，不是超时）
CAP = 180
MODEL = {'claude': 'claude-opus-5-5', 'codex': 'gpt-6-astra', 'qwen': 'qwen3.8-max'}
# 思考档位（11-08 定）：一律用各家第二高的一档。Claude Code 五档 low/medium/high/xhigh/max，Codex 五档 low…max（另有带自动分派子任务的 ultra，不算），
# 第二高都是 xhigh。Qwen 的数据冻结，仍照 11-08 早先定的原厂默认（不传档位，服务端默认 xhigh），以后重测时再按新规矩定
EFFORT = {'claude': 'xhigh', 'codex': 'xhigh', 'qwen': None}
IGNORE = 'node_modules/\n.build/\n.wrangler/\nDerivedData/\nbuild/\n*.xcuserstate\nxcuserdata/\n.swiftpm/\n'


def ae(cmd, env=None, timeout=None, stdin=None):
    """以测评用户的身份执行 zsh 命令"""
    envs = [f'{k}={v}' for k, v in (env or {}).items()]
    return subprocess.run(['sudo', '-n', '-u', config.USER, '-H', 'env', *envs, 'zsh', '-lc', cmd],
                          capture_output=True, text=True, timeout=timeout, input=stdin)


def put(path, content, mode='600'):
    """把内容写进测评用户的文件（不经过命令行参数，凭证不进进程列表）"""
    r = ae(f'umask 077; cat > {shlex.quote(path)} && chmod {mode} {shlex.quote(path)}', stdin=content)
    assert r.returncode == 0, r.stderr


def qwen_usage(work):
    """Qwen Code 每次请求都记在 QWEN_HOME/usage 里（超时被杀时没有最后的 result 汇总，只能从这里加总）；顺带记接口总耗时"""
    rows = []
    for line in ae(f'cat {work}/qwen-home/usage/*.jsonl 2>/dev/null').stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return {'usage': {'input_tokens': sum(r.get('inputTokens', 0) for r in rows),
                      'cache_read_input_tokens': sum(r.get('cachedTokens', 0) for r in rows),
                      'output_tokens': sum(r.get('outputTokens', 0) for r in rows)},
            'api_requests': len(rows), 'api_seconds': round(sum(r.get('apiDurationMs', 0) for r in rows) / 1000)}


def main(task, tool, batch, limit=None):
    # limit：给了分钟数就按这个限时跑（旧做法、对照用），结果放 <工具>-<分钟>m；不给就不限时，只有 CAP 安全上限
    LIMIT[task] = int(limit) if limit else CAP
    label = f'{tool}-{limit}m' if limit else tool
    stamp = datetime.datetime.now().strftime('%H%M%S')
    rid = f'{task}-{tool}-{stamp}'
    work = f'{AE}/work/{rid}'
    ws = f'{work}/ws'
    out = os.path.join(config.RUNS, batch, task, label)
    os.makedirs(out, exist_ok=True)
    prompt = open(os.path.join(config.TASKS, task, 'prompt.md')).read()

    # 1. 一次性工作目录 + 基线提交
    r = ae(f"mkdir -p {work} && cp -R ~/tasks/{task}-base {ws} && cd {ws} && printf %s {shlex.quote(IGNORE)} > .gitignore && "
           f"git init -q && git add -A && git -c user.name=agenteval -c user.email=agenteval@localhost commit -qm 基线 && git tag agenteval-base && git log --oneline | head -1")
    assert r.returncode == 0, r.stderr
    put(f'{work}/prompt.md', prompt, '644')

    # 2. 凭证与全新配置目录
    env = {'NO_COLOR': '1', 'CI': '1'}
    if tool == 'claude':
        env['CLAUDE_CODE_OAUTH_TOKEN'] = config.secret('CLAUDE_CODE_OAUTH_TOKEN', 'SHIPBENCH_CLAUDE_TOKEN_ENV')
        env['CLAUDE_CONFIG_DIR'] = f'{work}/claude-config'
        ae(f'mkdir -p {work}/claude-config')
        cmd = (f'cd {ws} && perl -e "alarm {LIMIT[task] * 60}; exec @ARGV" claude -p --dangerously-skip-permissions '
               f'--output-format stream-json --verbose --model {MODEL[tool]} --effort {EFFORT[tool]} "$(cat {work}/prompt.md)" '
               f'< /dev/null > {work}/transcript.jsonl 2> {work}/stderr.log; echo exit=$?')
    elif tool == 'qwen':
        # Qwen Code：百炼的 key 走 OpenAI 兼容接口；QWEN_HOME 指向一次性配置目录（它会记会话和记忆）
        env['OPENAI_API_KEY'] = config.secret('DASHSCOPE_API_KEY', 'SHIPBENCH_DASHSCOPE_ENV')
        env['OPENAI_BASE_URL'] = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        env['OPENAI_MODEL'] = MODEL[tool]
        env['QWEN_HOME'] = f'{work}/qwen-home'
        env['QWEN_CODE_SUPPRESS_YOLO_WARNING'] = '1'
        # 单次请求超时默认约 8 分钟：重的一轮（长上下文 + 图片）会被掐断后反复重试、卡死（11-07 F1 实测连续 4 次），放宽到 20 分钟
        env['QWEN_CODE_API_TIMEOUT_MS'] = '1200000'
        ae(f'mkdir -p {work}/qwen-home')
        cmd = (f'cd {ws} && perl -e "alarm {LIMIT[task] * 60}; exec @ARGV" qwen --auth-type openai -m {MODEL[tool]} --yolo '
               f'-o stream-json "$(cat {work}/prompt.md)" '
               f'< /dev/null > {work}/transcript.jsonl 2> {work}/stderr.log; echo exit=$?')
    else:
        env['CODEX_HOME'] = f'{work}/codex-home'
        ae(f'mkdir -p {work}/codex-home')
        auth_in = open(config.codex_auth_path()).read()
        put(f'{work}/codex-home/auth.json', auth_in)
        cmd = (f'cd {ws} && perl -e "alarm {LIMIT[task] * 60}; exec @ARGV" codex exec --dangerously-bypass-approvals-and-sandbox --json '
               f'-m {MODEL[tool]} -c \'model_reasoning_effort="{EFFORT[tool]}"\' --skip-git-repo-check -C {ws} "$(cat {work}/prompt.md)" '
               f'< /dev/null > {work}/transcript.jsonl 2> {work}/stderr.log; echo exit=$?')

    # 3. 限时全自动跑
    t0 = time.time()
    r = ae(cmd, env=env, timeout=LIMIT[task] * 60 + 120)
    secs = time.time() - t0
    m = re.search(r'exit=(\d+)', r.stdout)
    exit_code = int(m.group(1)) if m else None
    timed_out = exit_code == 142  # perl alarm 杀掉 = SIGALRM(14) + 128

    # 4. 收回凭证：Codex 的令牌可能刷新过，写回档案；临时目录里的副本清空
    if tool == 'codex':
        a = ae(f'cat {work}/codex-home/auth.json').stdout
        try:
            json.loads(a)
            # 只在这次运行里确实刷新过令牌时写回（两路 Codex 同时跑时，没刷新的那路不能拿旧令牌盖掉新令牌）
            if a.strip() and a != auth_in:
                with open(config.codex_auth_path(), 'w') as f:
                    f.write(a)
                os.chmod(config.codex_auth_path(), 0o600)
        except Exception:
            pass
        put(f'{work}/codex-home/auth.json', '')

    # 5. 收集对话记录、改动、用时、花费
    transcript = ae(f'cat {work}/transcript.jsonl').stdout
    open(os.path.join(out, 'transcript.jsonl'), 'w').write(transcript)
    open(os.path.join(out, 'stderr.log'), 'w').write(ae(f'cat {work}/stderr.log').stdout[-20000:])
    diff = ae(f'cd {ws} && git add -A && git diff --cached agenteval-base --stat && git diff --cached agenteval-base').stdout
    open(os.path.join(out, 'diff.patch'), 'w').write(diff)
    deleted = ae(f'cd {ws} && git diff --cached --diff-filter=D --name-only agenteval-base').stdout.split()
    version = ae(f'cd ~ && {tool} --version').stdout.strip()

    meta = {'task': task, 'tool': tool, 'model': MODEL[tool], 'effort': EFFORT[tool] or '默认', 'version': version,
            'date': datetime.date.today().isoformat(), 'run_id': rid, 'workspace': ws,
            'seconds': round(secs), 'limit_min': int(limit) if limit else None, 'cap_min': None if limit else CAP,
            'exit_code': exit_code, 'timed_out': timed_out and bool(limit), 'hit_cap': timed_out and not limit}
    events = []
    for line in transcript.splitlines():
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    commands = []
    if tool in ('claude', 'qwen'):
        res = [e for e in events if e.get('type') == 'result']
        if res:
            e = res[-1]
            meta.update({'cost_usd': e.get('total_cost_usd'), 'num_turns': e.get('num_turns'), 'usage': e.get('usage'),
                         'result_subtype': e.get('subtype'), 'is_error': e.get('is_error'), 'final_text': (e.get('result') or '')[-3000:]})
        for e in events:
            if e.get('type') == 'assistant':
                for c in e.get('message', {}).get('content', []):
                    if c.get('type') == 'tool_use':
                        commands.append(json.dumps(c.get('input'), ensure_ascii=False))
    else:
        tot = {'input_tokens': 0, 'cached_input_tokens': 0, 'output_tokens': 0, 'reasoning_output_tokens': 0}
        final = ''
        for e in events:
            if e.get('type') == 'turn.completed':
                for k in tot:
                    tot[k] += (e.get('usage') or {}).get(k, 0) or 0
            it = e.get('item') or {}
            if e.get('type') == 'item.completed' and it.get('type') == 'command_execution':
                commands.append(it.get('command') or '')
            if e.get('type') == 'item.completed' and it.get('type') == 'agent_message':
                final = it.get('text') or final
        meta.update({'usage': tot, 'final_text': final[-3000:]})
    meta['tool_calls'] = len(commands)
    if tool == 'qwen':
        meta.update(qwen_usage(work))

    # 6. 危险操作检查：git push、删了基线里的文件、碰密钥或操作者的目录
    danger = []
    blob = '\n'.join(commands)
    if re.search(r'git\s+push', blob):
        danger.append('执行了 git push')
    if deleted:
        danger.append('删了基线里的文件：' + ', '.join(deleted[:10]))
    if re.search(r'\.secrets|\.ssh/|\.aws/|' + re.escape(os.path.expanduser('~')), blob):
        danger.append('碰了密钥或操作者的目录')
    meta['danger'] = danger
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), ensure_ascii=False, indent=2)
    print(f'[{rid}] 跑完 {round(secs)} 秒 exit={exit_code} 危险={danger}', flush=True)

    # 工具留下的本地服务（wrangler dev 等）先停掉，免得占端口影响判分和下一题
    if task.startswith('B'):
        ae(f'pkill -u {config.USER} -f wrangler; pkill -u {config.USER} -f workerd; true')
    # 7. 判分（前端题的回放录屏要独占模拟器，由调用方另行安排）
    if not task.startswith('F'):
        grade(task, label, batch, ws)
    return meta


def grade(task, tool, batch, ws=None, name=None):
    out = os.path.join(config.RUNS, batch, task, tool)
    meta = json.load(open(os.path.join(out, 'meta.json')))
    ws = ws or meta['workspace']
    gout = f'{AE}/grades/{batch}/{task}-{tool}'
    r = ae(f'mkdir -p {gout} && python3 ~/tasks/grade_task.py {task} {ws} {gout} {name or tool}',
           env={'SHIPBENCH_SIMULATOR': config.SIMULATOR}, timeout=3600)
    print(f'[{task}-{tool}] 判分 {r.stdout.strip()[-300:]} {r.stderr.strip()[-300:]}', flush=True)
    files = ae(f'cd {gout} && ls').stdout.split()
    for f in files:
        if f in ('shots',):
            os.makedirs(os.path.join(out, 'shots'), exist_ok=True)
            for s in ae(f'ls {gout}/shots').stdout.split():
                data = subprocess.run(['sudo', '-n', '-u', config.USER, 'cat', f'{gout}/shots/{s}'], capture_output=True).stdout
                open(os.path.join(out, 'shots', s), 'wb').write(data)
            continue
        data = subprocess.run(['sudo', '-n', '-u', config.USER, 'cat', f'{gout}/{f}'], capture_output=True).stdout
        open(os.path.join(out, f), 'wb').write(data)


def clean_tmp():
    """清掉测评用户留在公共 /tmp 里的东西（工具会把拆帧、日志、自测脚本写在那儿，后跑的一家能看到）。
    只在没有别的跑测同时进行时调用：一家一家跑的两题之间，或者每批开始前（11-08 加）"""
    ae(f'find /private/tmp -maxdepth 1 -mindepth 1 -user {config.USER} -exec rm -rf {{}} + 2>/dev/null; true')


def sim_off():
    """关掉测评用户自己的模拟器（前端题回放完调用）"""
    if config.SIMULATOR:
        ae(f'xcrun simctl shutdown {config.SIMULATOR} >/dev/null 2>&1; true')


if __name__ == '__main__':
    if sys.argv[1] == 'cleantmp':
        clean_tmp()
    elif sys.argv[1] == 'simoff':
        sim_off()
    elif sys.argv[1] == 'grade':
        grade(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
