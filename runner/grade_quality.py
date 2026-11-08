#!/usr/bin/env python3
"""后端题的代码质量客观指标（11-08 定：后端加一项代码规整和风格，B2 = 功能验收 70% + 代码质量 30%）。
在测评用户里跑：python3 ~/tasks/grade_quality.py <工作目录> <输出 json>
只出客观指标，给评审当佐证；代码质量分本身由评审人按评审细则看改动打（见 bench/tasks/B2/README.md）。
工具版本锁在 ~/tasks/quality-tools（typescript 5.9.3、@biomejs/biome 1.9.4、jscpd 4.0.5），不用工具自己装的版本。

指标：
- 规模：源码文件数（src/ 下，不含测试）、非空行数、最大文件行数
- 类型检查：用它自己的 tsconfig 跑 tsc --noEmit 的报错数；再加 --strict 的报错数（没有 tsconfig 记 None）
- 代码检查：Biome 推荐规则 + 认知复杂度上限 15，按规则统计条数
- 重复：jscpd 算 src/ 里重复行的占比
- 自测：测试文件数、测试用例数（test( / it( 粗数）
"""
import json, os, re, subprocess, sys, tempfile

QT = os.path.expanduser('~/tasks/quality-tools/node_modules/.bin')
SKIP = {'node_modules', '.wrangler', '.git', 'dist', 'build', '.build'}


def sh(cmd, cwd, timeout=300):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def files(root, exts, under=None):
    out = []
    base = os.path.join(root, under) if under else root
    for d, ds, fs in os.walk(base):
        ds[:] = [x for x in ds if x not in SKIP]
        for f in fs:
            if f.endswith(exts):
                out.append(os.path.join(d, f))
    return sorted(out)


def is_test(p):
    return bool(re.search(r'(^|/)(tests?|__tests__)/|\.(test|spec)\.', p))


def main(ws, out):
    src = [p for p in files(ws, ('.ts', '.js', '.mjs'), 'src') if not is_test(p)] if os.path.isdir(os.path.join(ws, 'src')) else []
    tests = [p for p in files(ws, ('.ts', '.js', '.mjs')) if is_test(p)]
    lines = {os.path.relpath(p, ws): sum(1 for l in open(p, errors='ignore') if l.strip()) for p in src}
    r = {'源码文件数': len(src), '源码非空行数': sum(lines.values()),
         '最大文件': max(lines.items(), key=lambda kv: kv[1]) if lines else None,
         '测试文件数': len(tests),
         '测试用例数（粗数）': sum(len(re.findall(r'\b(?:test|it)\s*\(', open(p, errors='ignore').read())) for p in tests)}

    # 类型检查（自己的 tsconfig；再加 --strict）
    if os.path.exists(os.path.join(ws, 'tsconfig.json')):
        for key, extra in [('tsc 报错（自己的 tsconfig）', []), ('tsc 报错（加 --strict）', ['--strict'])]:
            p = sh([f'{QT}/tsc', '--noEmit', '-p', 'tsconfig.json', *extra], ws)
            errs = re.findall(r'error TS\d+', p.stdout + p.stderr)
            r[key] = len(errs)
            if key.endswith('--strict）'):
                r['tsc 报错示例'] = [l for l in (p.stdout + p.stderr).splitlines() if 'error TS' in l][:5]
    else:
        r['tsc 报错（自己的 tsconfig）'] = None

    # Biome：推荐规则 + 认知复杂度
    if src:
        cfgdir = tempfile.mkdtemp()
        json.dump({'linter': {'enabled': True, 'rules': {'recommended': True,
                   'complexity': {'noExcessiveCognitiveComplexity': {'level': 'warn', 'options': {'maxAllowedComplexity': 15}}}}},
                   'formatter': {'enabled': False}, 'files': {'ignoreUnknown': True}},
                  open(os.path.join(cfgdir, 'biome.json'), 'w'))
        p = sh([f'{QT}/biome', 'lint', f'--config-path={cfgdir}', '--max-diagnostics=1000', '--reporter=json', *src], ws)
        rules = {}
        try:
            j = json.loads(p.stdout[p.stdout.index('{'):])
            for d in j.get('diagnostics', []):
                c = d.get('category', '?')
                rules[c] = rules.get(c, 0) + 1
        except Exception:
            for c in re.findall(r'lint/[\w/]+', p.stdout + p.stderr):
                rules[c] = rules.get(c, 0) + 1
        r['Biome 告警数'] = sum(rules.values())
        r['Biome 每千行'] = round(sum(rules.values()) / max(r['源码非空行数'], 1) * 1000, 1)
        r['Biome 按规则'] = dict(sorted(rules.items(), key=lambda kv: -kv[1]))

        # jscpd：重复行占比
        rep = tempfile.mkdtemp()
        sh([f'{QT}/jscpd', '--silent', '--reporters', 'json', '--output', rep, '--min-lines', '5', '--min-tokens', '50',
            '--format', 'typescript,javascript', os.path.join(ws, 'src')], ws)
        try:
            jj = json.load(open(os.path.join(rep, 'jscpd-report.json')))
            r['重复行占比 %'] = round(jj['statistics']['total']['percentage'], 1)
        except Exception:
            r['重复行占比 %'] = None
    json.dump(r, open(out, 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(r, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
