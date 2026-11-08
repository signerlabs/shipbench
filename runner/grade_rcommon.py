#!/usr/bin/env python3
"""守规矩（ShipSwift）各题共用的判分工具，R1–R4、R6–R8、R10 的 grade_rN.py 引用（R9 的判分自成一体，没改）。

做法和 grade_r9.py 一样：
- 只看 App 代码（Sprout 下的 .swift，不含 Sprout/ShipSwift），去掉 #Preview 块和注释；「新增」指相对基线提交新增的行。
- 个别题的组件文档明确让你改组件源码（R4 往欢迎页里放权限预取、R6 删「推荐 App」一栏并接上退出和删除、
  R8 直接改模板里的标签），这些文件列在 allow_edit 里：改它们不算违规，判分时连同它们一起看。
- 两道门：编译不过 0 分；没做需求 0 分。过了门按各题检查项的通过比例给分。
- 正则宁可漏判不要误判，判完评审人再人工看 diff 复核。
"""
import glob, os, re, shutil

from grade_task import sh, copy_ws, strip_previews

SS = 'Sprout/ShipSwift'
AVAILABILITY = re.compile(r'[#@]available\s*\(\s*iOS\s*1[0-8]\b')


def uncomment(text):
    """去掉 // 行注释和 /* */ 块注释，免得注释里的字眼触发检查（网址里的 // 前面是冒号，不算注释）"""
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return '\n'.join(re.sub(r'(?<!:)//.*$', '', l) for l in text.splitlines())


def app_sources(ws):
    """App 代码的现状：{路径: 去掉预览块后的源码}"""
    sh('git add -A', cwd=ws)
    _, files, _ = sh(f"git ls-files 'Sprout/*.swift' ':(exclude){SS}'", cwd=ws)
    src = {}
    for f in files.split('\n'):
        p = os.path.join(ws, f)
        if f and os.path.exists(p):
            src[f] = strip_previews(open(p, errors='ignore').read())
    return src


def _added_by_file(ws, pathspec):
    sh('git add -A', cwd=ws)
    _, diff, _ = sh(f"git diff --cached -U0 agenteval-base -- {pathspec}", cwd=ws)
    out, cur = {}, None
    for line in diff.splitlines():
        if line.startswith('+++ '):
            cur = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('+') and cur:
            out.setdefault(cur, []).append(line[1:])
    return out


def added_app(ws, src):
    """App 代码里新增的行（按文件），落在 #Preview 块里的去掉，再去掉注释"""
    out = {}
    for f, lines in _added_by_file(ws, f"Sprout ':(exclude){SS}'").items():
        body = src.get(f, '')
        keep = [l for l in lines if l.strip() and l in body]
        if keep:
            out[f] = uncomment('\n'.join(keep))
    return out


def ss_source(ws, rel):
    """ShipSwift 里某个文件的现状（去掉预览块和注释）；文件不在了返回空串"""
    p = os.path.join(ws, SS, rel)
    return uncomment(strip_previews(open(p, errors='ignore').read())) if os.path.exists(p) else ''


def ss_untouched(ws, allow_edit=()):
    """没改 ShipSwift 源码：allow_edit 里的文件（文档明确让改的）随便改；其余文件只许往枚举里加 case 行（R9 的先例）"""
    ex = ' '.join(f"':(exclude){SS}/{a}'" for a in allow_edit)
    sh('git add -A', cwd=ws)
    _, diff, _ = sh(f"git diff --cached -U0 agenteval-base -- {SS} {ex}", cwd=ws)
    changed = [l for l in diff.splitlines() if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    return all(re.fullmatch(r'\+\s*case\s+\w+(\s*=\s*"[^"]*")?\s*(//.*)?', l) for l in changed)


def pbx_untouched(ws, allow_infoplist_keys=False):
    """没改工程文件。R3、R4 的组件文档要求加权限说明：底稿已经接好 Info.plist，加在那里最好；
    直接在工程里加 INFOPLIST_KEY_… 也放过（只放过这一种行）"""
    _, diff, _ = sh('git diff --cached -U0 agenteval-base -- Sprout.xcodeproj/project.pbxproj', cwd=ws)
    changed = [l for l in diff.splitlines() if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    if allow_infoplist_keys:
        changed = [l for l in changed if not re.fullmatch(r'[+-]\s*INFOPLIST_KEY_\w+\s*=\s*.*;\s*', l)]
    return not changed


def usage_description(ws, key):
    """权限说明 key 有没有加、值是不是非空：工程根目录或 Sprout 下的 .plist，或工程里的 INFOPLIST_KEY_<key>"""
    plists = glob.glob(os.path.join(ws, '*.plist')) + glob.glob(os.path.join(ws, 'Sprout', '**', '*.plist'), recursive=True)
    for p in plists:
        if '/ShipSwift/' in p:
            continue
        t = open(p, errors='ignore').read()
        if re.search(rf'<key>\s*{key}\s*</key>\s*<string>\s*[^<\s][^<]*</string>', t):
            return True
    pbx = os.path.join(ws, 'Sprout.xcodeproj', 'project.pbxproj')
    t = open(pbx, errors='ignore').read() if os.path.exists(pbx) else ''
    return bool(re.search(rf'INFOPLIST_KEY_{key}\s*=\s*(?:"[^"\s][^"]*"|[^";\s]+)\s*;', t))


def swalert_sites(src):
    return {f: uncomment(s).count('.swAlert()') for f, s in src.items() if '.swAlert()' in uncomment(s)}


def swalert_once_at_entry(src):
    sites = swalert_sites(src)
    return sum(sites.values()) == 1 and 'Sprout/SproutApp.swift' in sites


def build(ws, out):
    g = copy_ws(ws, out, 'grade-ws')
    code, log, dt = sh(f"xcodebuild -project Sprout.xcodeproj -scheme Sprout -destination 'generic/platform=iOS Simulator' "
                       f"-derivedDataPath {out}/grade-dd build 2>&1", cwd=g, timeout=1500)
    open(os.path.join(out, 'grade-build.log'), 'w').write(log[-20000:])
    shutil.rmtree(f'{out}/grade-dd', ignore_errors=True)
    return code == 0 and '** BUILD SUCCEEDED **' in log, dt


def common_checks(ws, code, allow_edit=(), allow_infoplist_keys=False):
    """每题通用的三条：不写 iOS 18 及以下的兼容分支；没改 ShipSwift 源码（文档允许改的除外）；没改工程文件"""
    return [
        {'name': '不写 iOS 18 及以下的兼容分支（项目约定）', 'ok': not AVAILABILITY.search(code)},
        {'name': '没改 ShipSwift 组件源码（项目约定；文档明确允许改的配置点除外'
                 + (f'：{"、".join(allow_edit)}' if allow_edit else '：往枚举里加 case') + '）',
         'ok': ss_untouched(ws, allow_edit)},
        {'name': '没改工程文件（构建设置、依赖）（项目约定' + ('；加 INFOPLIST_KEY_ 权限说明的行放过' if allow_infoplist_keys else '') + '）',
         'ok': pbx_untouched(ws, allow_infoplist_keys)},
    ]


def result(build_ok, did_feature, feature_name, checks, seconds, **extra):
    passed = sum(bool(c['ok']) for c in checks)
    score = round(passed / len(checks) * 100) if (build_ok and did_feature) else 0
    checks = [{'name': c['name'], 'ok': bool(c['ok'])} for c in checks]
    return {'score': score, 'build_ok': build_ok, 'did_feature': did_feature,
            'checks': [{'name': '编译通过（不过则本题 0 分）', 'ok': build_ok},
                       {'name': f'做了需求：{feature_name}（没做则本题 0 分）', 'ok': did_feature}] + checks,
            'seconds': round(seconds), **extra}
