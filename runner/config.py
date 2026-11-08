"""跑测配置：测评用户、模拟器、各家凭证的位置、结果目录。
先读 runner/local.env（不进仓库，按本机情况写），再读环境变量；环境变量优先。可配的项：

  SHIPBENCH_USER          测评专用的系统用户名（默认 agenteval）。各家工具只在这个用户里全自动跑
  SHIPBENCH_USER_HOME     这个用户的主目录（默认 /Users/<用户名>）
  SHIPBENCH_SIMULATOR     这个用户自己的 iOS 模拟器 UDID（前端题回放录屏用）
  SHIPBENCH_RUNS          跑测结果目录（默认仓库下的 runs/）
  CLAUDE_CODE_OAUTH_TOKEN 或 SHIPBENCH_CLAUDE_TOKEN_ENV（一个含 CLAUDE_CODE_OAUTH_TOKEN=... 的文件）
  SHIPBENCH_CODEX_AUTH    Codex 的 ChatGPT 登录凭证 auth.json 的路径（令牌刷新后会写回这个文件）
  DASHSCOPE_API_KEY 或 SHIPBENCH_DASHSCOPE_ENV（一个含 DASHSCOPE_API_KEY=... 的文件），Qwen Code 走百炼用
"""
import os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_local():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'local.env')
    if not os.path.exists(p):
        return
    for line in open(p):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), os.path.expanduser(v.strip().strip('"').strip("'")))


_load_local()

USER = os.environ.get('SHIPBENCH_USER', 'agenteval')
USER_HOME = os.environ.get('SHIPBENCH_USER_HOME', f'/Users/{USER}')
SIMULATOR = os.environ.get('SHIPBENCH_SIMULATOR', '')
RUNS = os.environ.get('SHIPBENCH_RUNS', os.path.join(REPO, 'runs'))
TASKS = os.path.join(REPO, 'tasks')


def env_file(path, key):
    for line in open(os.path.expanduser(path)):
        line = line.strip()
        if line.startswith(key + '='):
            return line[len(key) + 1:].strip().strip('"').strip("'")
    raise KeyError(key)


def secret(key, file_var):
    """先看环境变量 key，再看 file_var 指向的文件；都没有就报错"""
    if os.environ.get(key):
        return os.environ[key]
    if os.environ.get(file_var):
        return env_file(os.environ[file_var], key)
    raise SystemExit(f'缺少凭证：设置环境变量 {key}，或用 {file_var} 指向含 {key}=... 的文件')


def codex_auth_path():
    p = os.environ.get('SHIPBENCH_CODEX_AUTH')
    if not p:
        raise SystemExit('缺少 Codex 凭证：用 SHIPBENCH_CODEX_AUTH 指向 auth.json')
    return os.path.expanduser(p)
