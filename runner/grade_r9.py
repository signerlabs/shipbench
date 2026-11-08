#!/usr/bin/env python3
"""R9 守规矩（ShipSwift）：健身花费页。由 grade_task.py 按题号自动调用 grade(ws, out, name)。

一个需求踩 4 份文档：add-sheet（小面板用 SWAddSheet）、status-badge（标签用 SWStatusBadge）、
alert（全局提示 SWAlertManager、入口只挂一次 .swAlert()、不用延时等弹层）、swiftui-notes 第 54–56 条
（金额按地区解析、货币按地区显示、纯日期按当地正午解析）。另有项目约定（CLAUDE.md / AGENTS.md）的几条。

两道门：编译不过 0 分；没做需求（新增代码里没引用 ExpenseAPI、没调 fetch / add）0 分。
过了门按 14 条静态检查的通过比例给分。检查只看 App 代码（不含 Sprout/ShipSwift，去掉 #Preview 块），
「新增」指相对基线提交新增的行。正则宁可漏判不要误判，判完评审人再人工看两家的 diff 复核。
"""
import os, re, shutil

from grade_task import sh, copy_ws, strip_previews


def _app_sources(ws):
    sh('git add -A', cwd=ws)
    _, files, _ = sh("git ls-files 'Sprout/*.swift' ':(exclude)Sprout/ShipSwift'", cwd=ws)
    src = {}
    for f in files.split():
        p = os.path.join(ws, f)
        if os.path.exists(p):
            src[f] = strip_previews(open(p, errors='ignore').read())
    return src


def _added_by_file(ws):
    """相对基线新增的行，按文件分组（去掉 #Preview 块里的行做不到逐行判断，这里只按行看）"""
    sh('git add -A', cwd=ws)
    _, diff, _ = sh("git diff --cached -U0 agenteval-base -- Sprout ':(exclude)Sprout/ShipSwift'", cwd=ws)
    out, cur = {}, None
    for line in diff.splitlines():
        if line.startswith('+++ '):
            cur = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('+') and cur:
            out.setdefault(cur, []).append(line[1:])
    return out


def _uncomment(text):
    """去掉 // 行注释和 /* */ 块注释，免得注释里的字眼触发检查"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return '\n'.join(re.sub(r'(?<!:)//.*$', '', l) for l in text.splitlines())


def grade(ws, out, name='r9'):
    src = _app_sources(ws)
    allsrc = _uncomment('\n'.join(src.values()))
    added_files = _added_by_file(ws)
    # 新增代码：只算新增行，并去掉落在 #Preview 块里的（用去掉预览后的全文过一遍：新增行不在里面就是预览里的）
    add_lines = []
    for f, lines in added_files.items():
        body = src.get(f, '')
        for l in lines:
            if l.strip() and l in body:
                add_lines.append(l)
    add = _uncomment('\n'.join(add_lines))

    # 改 ShipSwift 组件源码算违规；但项目约定写明「文档明确允许改的配置点（枚举、网址、文案）可以改」，
    # 组件文档让用户往页面枚举里加 case（如 SWLoading.swift 的 SWLoadingPage：「Add your page cases here」）。
    # 所以只往枚举里加 case 行的不算（11-08 Codex 加了 case expenses 被误判，已修正）
    _, ss_full, _ = sh('git diff --cached -U0 agenteval-base -- Sprout/ShipSwift', cwd=ws)
    ss_changed = [l for l in ss_full.splitlines()
                  if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    ss_diff = '' if all(re.fullmatch(r'\+\s*case\s+\w+(\s*=\s*"[^"]*")?\s*(//.*)?', l) for l in ss_changed) else '\n'.join(ss_changed)
    _, pbx_diff, _ = sh('git diff --cached --stat agenteval-base -- Sprout.xcodeproj/project.pbxproj', cwd=ws)
    swalert = {f: _uncomment(s).count('.swAlert()') for f, s in src.items() if '.swAlert()' in _uncomment(s)}

    g = copy_ws(ws, out, 'grade-ws')
    bcode, blog, dt = sh(f"xcodebuild -project Sprout.xcodeproj -scheme Sprout -destination 'generic/platform=iOS Simulator' "
                         f"-derivedDataPath {out}/grade-dd build 2>&1", cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-build.log'), 'w').write(blog[-20000:])
    shutil.rmtree(f'{out}/grade-dd', ignore_errors=True)
    build_ok = bcode == 0 and '** BUILD SUCCEEDED **' in blog
    # 新增代码里引用了 ExpenseAPI，并且调了 fetch 和 add（接收者不限：可能先存进变量、属性，如 `let api = ExpenseAPI.shared` 再 `api.fetch()`）
    did_feature = 'ExpenseAPI' in add and bool(re.search(r'\.fetch\(\s*\)', add)) and bool(re.search(r'\.add\(', add))

    # —— 金额解析：按当前地区（swiftui-notes 第 55 条；第 54 条 Decimal(string:) 不拒杂字符）
    locale_parse = re.search(
        r'(?:Double|Decimal|Float)\(\s*[^()\n]*?,\s*format:'          # Double(text, format: .number) / Decimal(text, format: …)
        r'|[Pp]arseStrategy'                                          # FormatStyle 的 parseStrategy
        r'|NumberFormatter'                                           # NumberFormatter（locale 默认当前）
        r'|Decimal\(\s*string:[^)\n]*locale:', add)                   # Decimal(string:locale:)
    naive_parse = re.search(
        r'(?:Double|Float)\(\s*[\w.]*(?i:text|input|string|raw|entry)[\w.]*\s*\)'   # Double(text) / Double(inputText)
        r'|Decimal\(\s*string:(?!\s*")\s*[^,()\n]+\)', add)                            # Decimal(string: text)，不带 locale（字符串字面量不算：那是常量，不是解析用户输入）

    # —— 货币显示：跟地区走（swiftui-notes 第 55 条「回显与解析同一套 locale」；需求写明美、德、法三地）
    currency_fmt = re.search(r'\.currency\(|numberStyle\s*=\s*\.currency\b|Currency\(', add)
    literal_code = re.search(r'currency\(\s*code:\s*"', add)
    hard_symbol = re.search(r'"\s*[$€]|€\s*"|\$\\\(', add)

    # —— 纯日期：不按 UTC / GMT 解析（swiftui-notes 第 56 条）
    utc_parse = re.search(r'TimeZone\(\s*identifier:\s*"(?:UTC|GMT)"|TimeZone\(\s*abbreviation:\s*"(?:UTC|GMT)"'
                          r'|secondsFromGMT:\s*0\b|TimeZone\.gmt\b|timeZone\s*[:=]\s*\.gmt\b', add)
    # ISO8601DateFormatter / .iso8601 默认 GMT：除非同时把时区设成当前时区
    iso_default = bool(re.search(r'ISO8601DateFormatter|\.iso8601\b', add)) and not re.search(
        r'timeZone\s*[:=]\s*(?:\.current|TimeZone\.current|\.autoupdatingCurrent|TimeZone\.autoupdatingCurrent)', add)
    noon = re.search(r'hour:\s*12\b|\.hour\s*=\s*12\b|\.hour,\s*value:\s*12\b|bySettingHour:\s*12\b|12:00|T12\b|\bnoon\b', add, re.I)

    # —— 标签（status-badge 文档）
    badge = 'SWStatusBadge(' in add
    badge_error = re.search(r'SWStatusBadge\([^)]*\.error', add, re.S) or (
        re.search(r':\s*SWStatusBadgeStyle', add) and any('.error' in l and 'show(' not in l for l in add.splitlines()))

    checks = [
        {'name': '「+」小面板用 SWAddSheet（add-sheet 文档；约定：UI 优先用组件）', 'ok': 'SWAddSheet(' in add},
        {'name': '金额按当前地区解析（Double(_, format:)、parseStrategy、NumberFormatter、Decimal(string:locale:)）（swiftui-notes 第 55 条）', 'ok': bool(locale_parse)},
        {'name': '没有不带地区的解析：Double(文本)、Decimal(string:) 不带 locale（swiftui-notes 第 54、55 条）', 'ok': not naive_parse},
        {'name': '金额按货币格式显示，币种跟地区走：没写死币种代码，没写死 $ / €（swiftui-notes 第 55 条；需求：美、德、法）',
         'ok': bool(currency_fmt) and not literal_code and not hard_symbol},
        {'name': '纯日期不按 UTC / GMT 解析（不用 UTC、GMT 时区，不用默认 GMT 的 ISO8601 解析）（swiftui-notes 第 56 条）', 'ok': not utc_parse and not iso_default},
        {'name': '纯日期按当地正午解析（swiftui-notes 第 56 条）', 'ok': bool(noon)},
        {'name': '「Today」「Large」标签用 SWStatusBadge，Large 用 .error 红色样式（status-badge 文档）', 'ok': bool(badge and badge_error)},
        {'name': '成功、失败都用组件提示：SWAlertManager .show(.success …) 和 .show(.error …)（alert 文档）',
         'ok': bool(re.search(r'\.show\(\s*\.success', allsrc)) and bool(re.search(r'\.show\(\s*\.error', allsrc))},
        {'name': '.swAlert() 只挂一处，挂在 App 入口 SproutApp.swift（alert 文档 Usage 第 1 条）',
         'ok': sum(swalert.values()) == 1 and 'Sprout/SproutApp.swift' in swalert},
        {'name': '不用延时（asyncAfter / Task.sleep）等弹层关掉（alert 文档：提示在最上层窗口，sheet 盖不住）',
         'ok': not re.search(r'asyncAfter|Task\.sleep|Thread\.sleep|usleep\(', add)},
        {'name': '不自己写提示条、不用系统 .alert 提示（alert 文档）',
         'ok': not re.search(r'(struct|class|enum)\s+\w*(Toast|Banner|Snackbar|Hud|HUD)\w*', add) and not re.search(r'\.alert\(', add)},
        {'name': '不写 iOS 18 及以下的兼容分支（项目约定）', 'ok': not re.search(r'[#@]available\s*\(\s*iOS\s*1[0-8]\b', add)},
        {'name': '没改 ShipSwift 组件源码（项目约定）', 'ok': ss_diff.strip() == ''},
        {'name': '没改工程文件（构建设置、依赖）（项目约定）', 'ok': pbx_diff.strip() == ''},
    ]
    passed = sum(c['ok'] for c in checks)
    score = round(passed / len(checks) * 100) if (build_ok and did_feature) else 0
    return {'score': score, 'build_ok': build_ok, 'did_feature': did_feature,
            'checks': [{'name': '编译通过（不过则本题 0 分）', 'ok': build_ok},
                       {'name': '做了需求：新增代码用了 ExpenseAPI 并调了 fetch 和 add（没做则本题 0 分）', 'ok': did_feature}] + checks,
            'swAlert_sites': swalert, 'seconds': round(dt)}
