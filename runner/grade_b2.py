#!/usr/bin/env python3
"""B2 家庭物品与过期提醒的判分（由 grade_task.py 按题号分发过来，在测评用户 agenteval 里跑）。

在工作目录的副本里装依赖、跑隐藏验收脚本 ~/tasks/grade-B2.mjs（写 .dev.vars → 迁移 → 起本地服务 → 用例），
按通过比例给分。用例分三块：功能、鉴权与隔离、健壮性。
11-08 起再出一份代码质量客观指标（grade_quality.py），B2 总分 = 验收 70% + 代码质量 30%（代码质量由评审人打分）。
"""
import json, os, shutil, subprocess, time

TASKS = os.path.expanduser('~/tasks')


def sh(cmd, cwd=None, timeout=1800):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr, time.time() - t
    except subprocess.TimeoutExpired as e:
        return 124, str(e.stdout or '') + '\n[判分超时]', time.time() - t


def grade(ws, out, name=None):
    g = os.path.join(out, 'grade-ws')
    if os.path.exists(g):
        shutil.rmtree(g)
    shutil.copytree(ws, g, symlinks=True, ignore=shutil.ignore_patterns('.wrangler', '.dev.vars'))
    if not os.path.exists(os.path.join(g, 'node_modules')):
        sh('npm install --no-audit --no-fund 2>&1', cwd=g, timeout=600)
    # 工具自己起的本地服务可能还占着端口
    sh('pkill -u agenteval -f wrangler; pkill -u agenteval -f workerd; true')
    time.sleep(1)
    code, log, dt = sh(f"node {TASKS}/grade-B2.mjs {out}/grade-b2.json 2>&1", cwd=g, timeout=900)
    open(os.path.join(out, 'grade-b2.log'), 'w').write(log)
    sh('pkill -u agenteval -f wrangler; pkill -u agenteval -f workerd; true')
    try:
        r = json.load(open(os.path.join(out, 'grade-b2.json')))
    except Exception:
        return {'score': 0, 'checks': [{'name': '验收脚本跑通', 'ok': False}], 'log': log[-800:]}
    # 代码质量客观指标（11-08 加）：只当评审的佐证，分数由评审人看改动打，B2 总分 = 验收 70% + 代码质量 30%
    qcode, qlog, _ = sh(f"python3 {TASKS}/grade_quality.py {g} {out}/quality.json 2>&1", timeout=600)
    try:
        quality = json.load(open(os.path.join(out, 'quality.json')))
    except Exception:
        quality = {'错误': qlog[-500:]}
    return {'score': r['score'], 'acceptance_score': r['score'], 'quality': quality,
            'checks': [{'name': f"{c['block']}｜{c['name']}", 'ok': c['ok']} for c in r['cases']],
            'blocks': r.get('blocks'), 'setup': {k: v for k, v in r['setup'].items() if k != 'migrate'}, 'seconds': round(dt)}
