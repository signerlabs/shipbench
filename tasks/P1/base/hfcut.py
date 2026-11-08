"""短视频引擎（代码渲染，各产品共用）：口播与音效（ElevenLabs）、运镜、代码贴纸、特效、文字、转场、通用片尾。
时间线写成 HTML + GSAP，由 HyperFrames 逐帧渲染成 MP4：看到的就是成片，全程在后台跑，不用操作任何剪辑软件，
也不用剪映素材（剪映素材的授权只限中国大陆）。动画在 hf/runtime.js，片尾模板在 hf/片尾.html，贴纸在 代码贴纸/。

每个产品在 projects/<产品>/video/brand.py 里定义品牌参数；每条视频一个文件夹，里面的 build.py 用本模块描述时间线，运行后：
1. 生成 HyperFrames 工程 工程/（每次重写，不入库；不要在 Studio 里改它，改 build.py）；
2. lint 后渲染，响度校正到 −16 LUFS、真峰值不超过 −1 dBTP，成片按 发布文案.md 的英文标题命名，
   放进项目根目录的 成片/<序号> <标题>/，同一个文件夹里放一份 发布文案.md（标题和文案，发布时直接取），
   build.py 里写了封面（c.cover()）的，再出一张 封面.jpg；
3. 出抽帧拼图（预览/抽帧.jpg、手机尺寸.jpg、关键帧.jpg）和体检（预览/体检.txt：单帧跳变、静止段、音效时刻），
   再按七项打分自检。
运行：uv run --with pillow python build.py（只出封面：python build.py 封面；渲染前先看静帧和检查：python build.py 预检）
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

KIT = Path(__file__).resolve().parent
CACHE = KIT / "缓存"
SFX_DIR = KIT / "音效"
STICKER_DIR = KIT / "代码贴纸"
HF = KIT / "hf"
HF_BIN = HF / "node_modules" / ".bin" / "hyperframes"
FONT = KIT / "字体" / "TikTokSans-Variable.ttf"
GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"
# 不收集使用数据；不往全局装技能（技能由 Claude Code 里的 HyperFrames 插件提供）
ENV = {**os.environ, "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_SKIP_SKILLS": "1"}

W, H, FPS = 1080, 1920, 30  # 默认竖屏；横屏视频在 build.py 开头调 canvas(1920, 1080)


def canvas(w: int, h: int) -> None:
    """换画布尺寸（默认竖屏 1080×1920，给 TikTok）。横屏视频（X、Reddit）在 build.py 一开头调 canvas(1920, 1080)，
    之后的取景、文字、片尾都按新尺寸算。"""
    global W, H
    W, H = w, h
INK = "#1E2A24"            # 描边和深色字（偏品牌深绿的近黑）
PAPER = "#FFFDF7"          # 标签底色（偏暖的白）
CONFETTI = ["#FFD23F", "#FF5A5F", "#4ECDC4", "#738A56", "#FFFDF7", "#FF8A3D"]

VOICES = {
    "jessica": "cgSgspJ2msm6clMCkdW9",
    "sarah": "EXAVITQu4vr4xnSDxMaL",
    "laura": "FGY2WhTYpPnrIDTdsKH5",
    "liam": "TX3LPaxmHKxFdv7VOQHJ",
    "will": "bIHbv24MWmeRgasZH58o",
    "chris": "iP95p4xoKVk53GoZ742B",
}
# 中文口播用豆包语音合成 2.0 的母语音色（ElevenLabs 的英文音色念中文带口音），逐字时间由 ElevenLabs 强制对齐给出
DOUBAO_VOICES = {"vivi": "zh_female_vv_uranus_bigtts"}  # Vivi 2.0：年轻女声

# 音效提示词（ElevenLabs 音效生成，Creator 档可商用），首次用到时生成并缓存到 音效/
SFX_PROMPTS = {
    "shutter": ("A single crisp smartphone camera shutter click, close up, dry, no reverb", 0.6),
    "pop": ("A single soft cute bubble pop, short clean UI sound", 0.5),
    "whoosh": ("A fast clean whoosh swish, short video transition sound", 0.6),
    "tick": ("A single satisfying soft UI checkmark tick, short and clean", 0.5),
    "stamp": ("A light rubber stamp thump on paper, single hit, short", 0.5),
    "confetti": ("A party popper burst followed by sparkly confetti shimmer, celebratory, no voices", 1.8),
    "sparkle": ("A short magical sparkle shimmer swoosh, light and airy", 1.0),
    "chime": ("A gentle bright positive notification chime, single note, short", 1.0),
    "tumble": ("Several small light objects tumbling and softly clattering onto a pile on a table", 1.6),
    "zip": ("A suitcase zipper being zipped closed quickly, close up", 1.0),
    "boing": ("A playful cartoon boing, short and bouncy", 0.6),
    "tick_clock": ("A clock ticking, three ticks, quiet room at night", 1.6),
    "whirl": ("A soft airy whirl, small light objects swirling around in a circle, short and clean", 1.4),
    "float": ("A dreamy weightless shimmer, soft magical twinkle, gentle and airy, no music", 2.0),
    "slide": ("A pile of many small light objects sliding and shuffling across a smooth surface, soft clatter", 1.6),
    "reel_spin": ("Slot machine reels spinning fast, continuous rapid light mechanical ticking, steady, no bell, no music", 4.0),
    "reel_stop": ("A single slot machine reel stopping with a firm short mechanical click-clunk, close up, dry, no bell", 0.5),
    "jackpot": ("A short bright arcade win sound: one bell ding and a few coins dropping, no voice, no music", 1.6),
    "card_flip": ("A single playing card flipped over quickly on a table, crisp paper flick, close up, dry", 0.5),
    "typing": ("Typing on a laptop keyboard, light steady keystrokes, close up, dry, no voice, no music", 4.0),
}

# 各音效的默认音量（1.0 为原始音量；音效峰值已归一到 -3 dBFS，按口播响度调过，叠在口播上不爆音）
SFX_VOLUME = {"shutter": 0.42, "pop": 0.38, "whoosh": 0.28, "tick": 0.38, "stamp": 0.42, "confetti": 0.36,
              "sparkle": 0.32, "chime": 0.25, "tumble": 0.32, "zip": 0.35, "boing": 0.28, "tick_clock": 0.18,
              "whirl": 0.3, "float": 0.22, "slide": 0.32, "reel_spin": 0.22, "reel_stop": 0.4, "jackpot": 0.3,
              "card_flip": 0.4, "typing": 0.22}

VO_LUFS = -16.0  # 口播目标响度；成片整体也校正到这里
COVER_HEAD = 0.3  # Brand.cover_in_video 的项目：封面在成片开头停这么久（平台默认拿第一帧当封面）

# 代码贴纸（代码贴纸/<名字>.svg）各自的默认动作，和动作的轴心
STICKER_ACTS = {
    "闹钟": "ring", "相机": "shutter", "星星脸": "sway", "衣架": "swing", "箭头": "draw", "震惊线": "shake",
    "乱麻": "draw", "警示": "blink", "WOW": "pulse", "OMG": "pulse", "红圈": "draw", "烟花": "fireworks",
    "加载条": "fill", "闪光": "twinkle", "电池": "fill", "加载窗口": "fill", "定位针": "drop", "礼花筒": "burst",
    "对号": "draw", "领带": "swing", "手机": "tilt", "惊讶眼睛": "look", "围巾": "sway", "弯箭头": "draw",
    "行李箱": "bounce", "手指": "tap", "问号": "sway", "点赞": "pulse", "日历": "bounce", "旋转箭头": "spin",
    "放大镜": "scan", "太阳": "spin-rays", "一套衣服": "sway",
}
STICKER_ORIGIN = {"衣架": "50% 6%", "领带": "50% 14%", "手机": "50% 90%", "行李箱": "50% 100%", "日历": "50% 100%"}
NO_POP = {"红圈", "乱麻", "箭头", "弯箭头", "定位针"}  # 这些不弹出：一笔描出来，或者从上面落下来

# 转场：前后两段在剪辑点重叠半个转场（视频不越过剪辑点，重叠的那半用静帧垫着）；闪白、快门、震切是硬切
TRANSITIONS = {"甩镜": "whip-left", "上甩": "whip-up", "冲镜": "zoom", "推移": "push", "叠化": "fade",
               "闪白": "flash", "快门": "shutter", "震切": "shake"}
OVERLAP = {"whip-left", "whip-up", "zoom", "push", "fade"}

# 特效：画面层（整体抖、跳、推、晃）和叠加层（在画面之上、文字和贴纸之下）
FX = {"震动": [("stage", "shake")], "心跳": [("stage", "heartbeat")], "推镜": [("stage", "punch")],
      "摇晃运镜": [("stage", "sway")], "闪光推镜": [("overlay", "flash"), ("stage", "punch")],
      "震动屏闪": [("stage", "shake"), ("overlay", "flash")], "冲击波": [("overlay", "shockwave")],
      "速度线": [("overlay", "speedlines")], "满屏问号": [("overlay", "qmarks")], "聚光灯": [("overlay", "spotlight")],
      "聚光灯金粉": [("overlay", "spotlight"), ("overlay", "glitter")], "竖向闪光": [("overlay", "vflash")],
      "十字爆闪": [("overlay", "crossflash")], "金粉": [("overlay", "glitter")], "暗角": [("overlay", "vignette")],
      "丁达尔光线": [("overlay", "rays")], "虚线圈": [("overlay", "dashcircle")], "撒花": [("confetti", "")]}

# 标题样式：(字色, 描边, 立体投影, 强调色, 发光)
TITLE_STYLES = {
    "黄字": ("#FFE14D", INK, "#31473F", "#FF5A5F", None),
    "白字立体": ("#FFFFFF", INK, "#FF5A5F", "#FFE14D", None),
    "蓝光": ("#FFFFFF", "#1D4ED8", None, "#FFE14D", "#60A5FA"),
    "红黄": ("#FFE14D", "#C81E1E", INK, "#FFFFFF", None),
    "蓝黄": ("#FFE14D", "#1E3A8A", "#1E3A8A", "#FFFFFF", None),
}
TEXT_INTROS = {"pop", "rise", "slam", "slide", "type", "cut"}
TEXT_LOOPS = {"bounce", "float", "swing", "shake"}

# 层级（z-index）：画面在 #stage 里；叠加层、文字、贴纸、撒花、片尾依次往上
TRACK_Z = {"main": 100, "broll": 300, "card": 500, "sticker": 700}
Z_FX, Z_TRANS, Z_CUT, Z_TEXT, Z_STICKER, Z_CONFETTI, Z_OUTRO = 1000, 1100, 1200, 1300, 1400, 1500, 2000


# ---------- 命令与接口 ----------

def run(*args) -> subprocess.CompletedProcess:
    p = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"命令失败：{' '.join(map(str, args))}\n{p.stderr[-2000:]}")
    return p


def _hf(*args) -> subprocess.CompletedProcess:
    p = subprocess.run([str(HF_BIN), *map(str, args)], capture_output=True, text=True, env=ENV)
    if p.returncode:
        raise RuntimeError(f"hyperframes {' '.join(map(str, args))} 失败：\n{(p.stdout + p.stderr)[-3000:]}")
    return p


def _env(path: str, key: str) -> str:
    for line in Path(path).expanduser().read_text().splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise KeyError(key)


def _eleven(path: str, body: dict, *, want_json: bool = True):
    req = urllib.request.Request(
        "https://api.elevenlabs.io" + path, data=json.dumps(body).encode(),
        headers={"xi-api-key": _env("~/.secrets/elevenlabs/api.env", "ELEVENLABS_API_KEY"),
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r) if want_json else r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs {path} 报错 {e.code}：{e.read().decode()[:500]}") from None


def _doubao(text: str, speaker: str, speed: float) -> bytes:
    """豆包语音合成 2.0（中文口播），返回 MP3。按量计费。
    它自带的逐字时间戳不可靠（英文词的位置不对，句尾的字收得早），时间另由 _align 对齐。"""
    body = {"user": {"uid": "video-kit"},
            "req_params": {"text": text, "speaker": speaker,
                           "audio_params": {"format": "mp3", "sample_rate": 44100, "bit_rate": 192000,
                                            "speech_rate": round((speed - 1) * 100)},  # 0 是原速，100 是两倍速
                           "additions": json.dumps({"explicit_language": "zh"})}}
    req = urllib.request.Request(
        "https://openspeech.bytedance.com/api/v3/tts/unidirectional", data=json.dumps(body).encode(),
        headers={"X-Api-Key": _env("~/.secrets/volcengine/api.env", "VOLC_SPEECH_API_KEY"),
                 "X-Api-Resource-Id": "seed-tts-2.0", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        rows = [json.loads(row) for row in r.read().decode().splitlines() if row.strip()]
    bad = next((j for j in rows if j.get("code") not in (0, 20000000)), None)
    if bad:
        raise RuntimeError(f"豆包语音合成报错 {bad.get('code')}：{bad.get('message')}")
    audio = b"".join(base64.b64decode(j["data"]) for j in rows if j.get("data"))
    if not audio:
        raise RuntimeError("豆包语音合成没有返回音频")
    return audio


def _align(audio: bytes, text: str) -> dict:
    """ElevenLabs 强制对齐：给音频和原文，回逐字的起止秒数，格式同 ElevenLabs 配音带的时间戳。"""
    boundary = "videokit" + hashlib.sha1(audio[:4096]).hexdigest()[:16]
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n{text}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="vo.mp3"\r\n'
            f'Content-Type: audio/mpeg\r\n\r\n').encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/forced-alignment", data=body,
        headers={"xi-api-key": _env("~/.secrets/elevenlabs/api.env", "ELEVENLABS_API_KEY"),
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            chars = json.load(r)["characters"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ElevenLabs 强制对齐报错 {e.code}：{e.read().decode()[:500]}") from None
    return {"characters": [c["text"] for c in chars], "character_start_times_seconds": [c["start"] for c in chars],
            "character_end_times_seconds": [c["end"] for c in chars]}


# ---------- 媒体 ----------

@dataclass
class Media:
    path: Path
    w: int
    h: int
    duration: float
    is_image: bool


def probe(path: Path) -> Media:
    """读宽高（已按旋转元数据换算成显示方向）和时长。"""
    d = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path).stdout)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        return Media(Path(path), 0, 0, float(d["format"]["duration"]), False)
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list", []):
        rot = int(sd.get("rotation", rot) or 0)
    if abs(rot) in (90, 270):
        w, h = h, w
    is_image = Path(path).suffix.lower() in (".png", ".jpg", ".jpeg")
    return Media(Path(path), w, h, float(d["format"].get("duration", 0) or 0), is_image)


# 预设调色（ffmpeg 滤镜），烘焙进素材副本
GRADES = {
    # 白天的室内片调成深夜台灯下：压暗、偏暖、加暗角
    "night": "eq=gamma=0.7:saturation=0.85,colortemperature=temperature=3500:mix=0.8,vignette=angle=PI/4",
}


def grade(src: Path, preset: str) -> Path:
    """按预设调色并去掉元数据，输出 H.264 副本到缓存（同一素材同一预设只做一次）。"""
    src = Path(src)
    key = hashlib.sha1(f"{src.name}:{src.stat().st_size}:{GRADES[preset]}".encode()).hexdigest()[:8]
    dst = CACHE / f"{src.stem}-{preset}-{key}.mp4"
    if not dst.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        run("ffmpeg", "-y", "-nostdin", "-i", src, "-map", "0:v:0", "-an", "-vf", GRADES[preset],
            "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-map_metadata", "-1", dst)
    return dst


def still(src: Path, t: float, out_dir: Path) -> Path:
    """原片第 t 秒那一帧（原尺寸 PNG），用来垫静止的画面（不靠极慢的变速）。"""
    src = Path(src)
    out = Path(out_dir) / f"{src.stem[:8]}-{t:.2f}.png"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        run("ffmpeg", "-y", "-nostdin", "-ss", f"{t:.3f}", "-i", src, "-frames:v", "1", out)
    return out


def solid(color: str, out_dir: Path) -> Path:
    """整张纯色底图（画布大小）：推近到录屏边缘时，垫在底下露出来的部分。"""
    from PIL import Image
    out = Path(out_dir) / f"底色-{color.lstrip('#')}.png"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (W, H), color).save(out)
    return out


def card(src: Path, t: float, box: tuple[float, float, float, float], out_dir: Path, *,
         radius: float = 40, border: float = 0, shadow: bool = True) -> Path:
    """从原片第 t 秒那一帧（图片就用图片本身）裁出一块，圆角加柔和投影，存成透明 PNG 给 cutout() 用（封面上的 App 卡片）。
    box 是铺满画布时的坐标（左, 上, 右, 下），可以超出画布（录屏上下各有约 210 像素铺满时被裁掉）；
    radius、border（白边宽）也按画布像素算，裁出来的图保留原分辨率。
    有投影时 PNG 四周留了空白（各约 48 画布像素），cutout() 的 size_px 量的是连空白在内的宽度。
    shadow=False、radius=0 裁出来的是一块原样的画面：垫一张同色底图（solid），就能把 App 里的东西搬到别处、
    不带 App 的标题栏和按钮（App 底色是 #F0EDE2）。"""
    from PIL import Image, ImageDraw, ImageFilter
    src = Path(src)
    key = hashlib.sha1(f"{src.resolve()}:{t:.3f}:{box}:{radius}:{border}:{shadow}".encode()).hexdigest()[:8]
    out = Path(out_dir) / f"卡片-{key}.png"
    if out.exists():
        return out
    im = Image.open(src if probe(src).is_image else still(src, t, out_dir)).convert("RGBA")
    s = max(W / im.width, H / im.height)  # 铺满画布的缩放（同 clip()：上下或左右裁掉多出来的）
    ox, oy = (im.width * s - W) / 2, (im.height * s - H) / 2
    l, top, r, b = box
    tile = im.crop(tuple(round(v) for v in ((l + ox) / s, (top + oy) / s, (r + ox) / s, (b + oy) / s)))
    k = 1 / s  # 画布像素 → 原图像素

    def rounded(size: tuple[int, int], r: float) -> Image.Image:
        mask = Image.new("L", size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=max(0, round(r)), fill=255)
        return mask

    bw = round(border * k)
    if bw:  # 白边：外圈圆角，里面的画面也跟着圆
        framed = Image.new("RGBA", (tile.width + 2 * bw, tile.height + 2 * bw), "white")
        framed.paste(tile, (bw, bw), rounded(tile.size, (radius - border) * k))
        tile = framed
    mask = rounded(tile.size, radius * k)
    pad = round(48 * k) if shadow else 0
    canvas = Image.new("RGBA", (tile.width + 2 * pad, tile.height + 2 * pad), (0, 0, 0, 0))
    if shadow:
        drop = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        drop.paste((0, 0, 0, 110), (pad, pad + round(14 * k)), mask)
        canvas = Image.alpha_composite(canvas, drop.filter(ImageFilter.GaussianBlur(round(20 * k))))
    canvas.paste(tile, (pad, pad), mask)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out)
    return out


def _trash(p: Path) -> None:
    """移到废纸篓（可找回）。名字太长时截短，免得超过文件名上限。"""
    stem = p.name.encode()[:120].decode(errors="ignore").rstrip()
    dst = Path.home() / ".Trash" / f"{stem} {time.strftime('%H%M%S')}"
    n = 1
    while dst.exists():
        dst = dst.with_name(f"{stem} {time.strftime('%H%M%S')}-{n}")
        n += 1
    shutil.move(str(p), str(dst))


def proxy(src: Path) -> Path:
    """视频素材的剪辑代理：H.264、每秒一个关键帧、去掉声音和元数据，缓存在 缓存/hf代理/（同一文件只转一次）。
    HyperFrames 渲染时按帧从视频里抽画面，关键帧太稀（Pexels 的片子常常 3–8 秒一个）会抽错帧，
    整段画面的叠加层跟着乱（10-18 FP09：高尔夫那段起，后面的标签、贴纸全叠了上来）。画质用 crf 14，看不出差别。"""
    src = Path(src)
    st = src.stat()
    color = run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer,color_primaries",
                "-of", "csv=p=0", src).stdout.strip()
    # HDR 素材（Pexels 有的片子是 HLG / BT.2020）转成普通的 BT.709：HyperFrames 见到 HDR 就改走分层合成，
    # 输出变成 HEVC 10 位，叠加层也会乱（10-18 FP09 的徒步实拍）。HLG 本来就兼顾普通屏幕，换算色域即可
    hdr = "arib-std-b67" in color or "smpte2084" in color or "bt2020" in color
    if "smpte2084" in color:
        print(f"提醒：{src.name} 是 PQ 格式的 HDR，本机 ffmpeg 没有 zscale，只能粗略转换，颜色可能偏暗，最好换一段素材")
    vf = ["-vf", "colorspace=all=bt709:iall=bt2020:itrc=bt2020-10:format=yuv420p"] if hdr else []
    key = hashlib.sha1(f"{src.resolve()}:{st.st_size}:{int(st.st_mtime)}:{'sdr' if hdr else ''}".encode()).hexdigest()[:10]
    out = CACHE / "hf代理" / f"{re.sub(r'[^A-Za-z0-9]+', '-', src.stem)[:24].strip('-') or 'video'}-{key}.mp4"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp.mp4")
        run("ffmpeg", "-y", "-nostdin", "-i", src, "-map", "0:v:0", "-an", *vf, "-c:v", "libx264", "-preset", "medium",
            "-crf", "14", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-movflags", "+faststart", "-map_metadata", "-1", tmp)
        tmp.replace(out)
    return out


def _tail_still(src: Path, t: float) -> Path:
    """转场垫的静帧（缩到 1080 宽 JPG，缓存）：前一段停在最后一帧、后一段停在第一帧，
    免得露出剪辑点之外的原片（10-18 第一版：前一段多放的 0.15 秒里已经切到了下一个页面）。"""
    key = hashlib.sha1(f"{Path(src).resolve()}:{t:.3f}".encode()).hexdigest()[:10]
    out = CACHE / "hf静帧" / f"{key}.jpg"
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        if probe(src).is_image:
            run("ffmpeg", "-y", "-nostdin", "-i", src, "-vf", "scale=1080:-2", "-q:v", "2", out)
        else:
            run("ffmpeg", "-y", "-nostdin", "-ss", f"{max(0.0, t):.3f}", "-i", src, "-frames:v", "1",
                "-vf", "scale=1080:-2", "-q:v", "2", out)
    return out


def peaknorm(src: Path, dst: Path, peak_db: float = -3.0) -> None:
    """短音效按峰值归一（短于 3 秒的音频不适合用 loudnorm）。"""
    p = run("ffmpeg", "-hide_banner", "-nostdin", "-i", src, "-af", "volumedetect", "-f", "null", "-")
    mx = float(p.stderr.split("max_volume:")[1].split("dB")[0])
    run("ffmpeg", "-y", "-nostdin", "-i", src, "-af", f"volume={peak_db - mx}dB", "-ar", "44100", "-b:a", "192k", dst)


def loudness(path: Path) -> tuple[float, float]:
    """整段响度（LUFS）和真峰值（dBTP，按 4 倍过采样量，AAC 编码后会冒出来的样点间峰值也算进去）。"""
    p = run("ffmpeg", "-hide_banner", "-nostdin", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-")
    tail = p.stderr[p.stderr.rindex("Summary:"):]
    return float(tail.split("I:")[1].split("LUFS")[0]), float(tail.split("Peak:")[1].split("dBFS")[0])


def voicenorm(src: Path, dst: Path, lufs: float = VO_LUFS, tp: float = -1.5) -> None:
    """口播响度归一：先把整段拉到 -20 LUFS 过一道 3:1 压缩，再补增益到 lufs，最后用限幅器把峰值压在 tp 以下。
    不用 loudnorm：短句达不到目标时它会退回动态模式，响度差得远（10-17 实测，两句一段的口播只有 -21 LUFS）。"""
    # 临时文件名带上目标路径的哈希和进程号：各条视频的口播都叫「口播.mp3」，几条同时生成时不能共用一个临时文件（10-19 小店 20 条并行时撞过）
    key = hashlib.sha1(str(Path(dst).resolve()).encode()).hexdigest()[:8]
    tmp = CACHE / f"{Path(dst).stem}-{key}-{os.getpid()}-压缩.wav"
    run("ffmpeg", "-y", "-nostdin", "-i", src, "-af",
        f"volume={-20 - loudness(src)[0]:.2f}dB,acompressor=threshold=0.1:ratio=3:attack=5:release=100:knee=2",
        "-c:a", "pcm_f32le", tmp)
    gain = lufs - loudness(tmp)[0]
    for _ in range(3):
        run("ffmpeg", "-y", "-nostdin", "-i", tmp, "-af",
            f"volume={gain:.2f}dB,alimiter=limit={10 ** (tp / 20):.4f}:attack=4:release=60:level=0:latency=1",
            "-ar", "44100", "-b:a", "192k", dst)
        miss = lufs - loudness(dst)[0]
        if abs(miss) < 0.3:
            break
        gain += miss
    tmp.unlink()


# ---------- 口播 ----------

@dataclass
class Word:
    text: str
    start: float
    end: float

    @property
    def clean(self) -> str:
        return self.text.strip(".,!?;:…\"'“”").lower()


@dataclass
class Voice:
    path: Path
    words: list[Word]
    duration: float

    def span(self, phrase: str, after: float = 0.0) -> tuple[float, float]:
        """找短语在口播里的起止秒数（after 之后第一次出现）。"""
        want = [Word(t, 0, 0).clean for t in phrase.split()]
        hits = [(self.words[i].start, self.words[i + len(want) - 1].end)
                for i in range(len(self.words) - len(want) + 1)
                if self.words[i].start >= after and [w.clean for w in self.words[i:i + len(want)]] == want]
        if not hits:
            raise KeyError(f"口播里找不到「{phrase}」")
        if len(hits) > 1 and after == 0.0:  # 同一个词出现好几次时很容易取错（10-17 FP07、FP10 都踩过）
            print(f"提醒：口播里「{phrase}」出现了 {len(hits)} 次（" + "、".join(f"{h[0]:.2f}" for h in hits) +
                  " 秒），取了第一次；要后面那次请加 after=")
        return hits[0]

    def at(self, phrase: str, after: float = 0.0) -> float:
        return self.span(phrase, after)[0]

    def end_of(self, phrase: str, after: float = 0.0) -> float:
        return self.span(phrase, after)[1]

    def _db(self) -> list[float]:
        """口播每 10 毫秒的能量（dBFS），切段找词头、找静处用；第一次用到时算一次。"""
        if getattr(self, "_env", None) is None:
            from array import array
            pcm = array("h", subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(self.path), "-ac", "1", "-ar", "16000",
                                             "-f", "s16le", "-"], capture_output=True, check=True).stdout)
            self._env = [10 * math.log10(sum(s * s for s in pcm[i:i + 160]) / 160 / 32768 ** 2 + 1e-12)
                         for i in range(0, len(pcm), 160)]
        return self._env

    def cut_before(self, t: float, window: float = 0.25) -> float:
        """t 之前 window 秒里最安静的那一刻。切口播从这里切进去，不会切掉词头：对齐给的词头常晚 0.06–0.12 秒，
        FP16 的「Charger」还把前面的停顿算进了词里，晚了 0.38 秒（10-18 新评审用互相关查出来的）。"""
        db = self._db()
        a, b = max(0, int((t - window) / 0.01)), min(len(db), int(t / 0.01) + 1)
        return (min(range(a, b), key=lambda i: db[i]) if b > a else a) * 0.01

    def onset(self, t: float, floor: float = -32.0) -> float:
        """t 那个词真正出声的时刻：从 cut_before(t) 往后，能量第一次超过 floor dB。剪辑点要对在词上时用它，别直接用对齐的起点。"""
        db, k = self._db(), int(self.cut_before(t) / 0.01)
        while k < len(db) and db[k] < floor:
            k += 1
        return k * 0.01

    def quiet_after(self, t: float, floor: float = -30.0) -> float:
        """t 之后口播第一次静下来（低于 floor dB 至少 0.1 秒）的时刻。中文句尾的字，对齐给的结束时间偏早，
        句间又常有吸气声，按这个找真正说完的地方。至少 0.1 秒：词尾爆破音（Laptop 的 p）发出来之前有一小段闭塞，
        短于 0.1 秒，不能当成说完了（FP16 第二轮评审）。"""
        p = run("ffmpeg", "-hide_banner", "-nostdin", "-i", self.path, "-af", f"silencedetect=noise={floor}dB:d=0.1",
                "-f", "null", "-")
        return next((s for s in map(float, re.findall(r"silence_start: ([\d.]+)", p.stderr)) if s > t), self.duration)


def _words(al: dict) -> list[Word]:
    out, cur, s, e = [], "", 0.0, 0.0
    for c, a, b in zip(al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]):
        if c.isspace():
            if cur:
                out.append(Word(cur, s, e))
                cur = ""
            continue
        if not cur:
            s = a
        cur += c
        e = b
    if cur:
        out.append(Word(cur, s, e))
    return out


def tts(text: str, out: Path, *, voice: str = "jessica", speed: float = 1.06, model: str = "eleven_v4") -> Voice:
    """生成口播（带逐字时间戳），响度归一后存到 out，同时写一份逐词时间轴 .words.json。
    原声按参数缓存在 缓存/tts-*：同一句话不会重新生成，语气和时长不变。
    voice 是 DOUBAO_VOICES 里的（中文口播）就用豆包语音合成，再用 ElevenLabs 强制对齐出逐字时间。"""
    if voice in DOUBAO_VOICES:
        model = "seed-tts-2.0"
    params = {"text": text, "voice": voice, "speed": speed, "model": model}
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:10]
    raw, align = CACHE / f"tts-{key}.mp3", CACHE / f"tts-{key}.json"
    if not raw.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        if voice in DOUBAO_VOICES:
            audio = _doubao(text, DOUBAO_VOICES[voice], speed)
            alignment = _align(audio, text)
        else:
            d = _eleven(f"/v1/text-to-speech/{VOICES[voice]}/with-timestamps?output_format=mp3_44100_192",
                        {"text": text, "model_id": model,
                         "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "speed": speed}})
            audio, alignment = base64.b64decode(d["audio_base64"]), d["alignment"]
        raw.write_bytes(audio)
        align.write_text(json.dumps(alignment))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists() or out.stat().st_mtime < raw.stat().st_mtime:
        voicenorm(raw, out)
    words = _words(json.loads(align.read_text()))
    out.with_suffix(".words.json").write_text(json.dumps([w.__dict__ for w in words], ensure_ascii=False, indent=1))
    return Voice(out, words, probe(out).duration)


MAJOR = [0, 2, 4, 5, 7, 9, 11]   # 大调音阶：一串事件按音阶一个比一个高（FP12 起的啪声），semis=H.step(k)


def step(k: int, base: int = 0) -> int:
    """大调音阶第 k 级（0 起，往上接着跨八度）比 base 高几个半音。"""
    return base + MAJOR[k % 7] + 12 * (k // 7)


def pitched(src: Path, semis: int) -> Path:
    """音效升降 semis 个半音（连带变快变慢，短音效听不出来），缓存在 缓存/音阶/。"""
    src = Path(src)
    dst = CACHE / "音阶" / f"{src.stem}{semis:+d}.mp3"
    if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
        dst.parent.mkdir(parents=True, exist_ok=True)
        run("ffmpeg", "-y", "-nostdin", "-i", src, "-af",
            f"aresample=44100,asetrate={44100 * 2 ** (semis / 12):.1f},aresample=44100", dst)
    return dst


_PEAKS: dict[Path, float] = {}


def sfx_peak(path: Path) -> float:
    """音效最响那一下离文件开头几秒（10 毫秒一格的包络取最大）。ElevenLabs 生成的音效不少开头有一段铺垫：
    tumble、slide、whirl、zip、float 的峰值在 0.43–0.58 秒，tick_clock 的第一下在 0.73 秒（10-18 量）。"""
    path = Path(path)
    if path not in _PEAKS:
        from array import array
        pcm = array("h", subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-ac", "1", "-ar", "16000",
                                         "-f", "s16le", "-"], capture_output=True, check=True).stdout)
        energy = [sum(s * s for s in pcm[i:i + 160]) for i in range(0, len(pcm), 160)]
        _PEAKS[path] = (energy.index(max(energy)) + 0.5) * 0.01
    return _PEAKS[path]


def sfx(name: str) -> Path:
    """音效文件（首次用到时按 SFX_PROMPTS 生成，峰值归一到 -3 dBFS）。"""
    p = SFX_DIR / f"{name}.mp3"
    if not p.exists():
        SFX_DIR.mkdir(parents=True, exist_ok=True)
        prompt, dur = SFX_PROMPTS[name]
        audio = _eleven("/v1/sound-generation", {"text": prompt, "duration_seconds": dur, "prompt_influence": 0.6},
                        want_json=False)
        raw = CACHE / f"sfx-{name}-raw.mp3"
        raw.write_bytes(audio)
        peaknorm(raw, p)
    return p


# ---------- 运镜 ----------

def focus(k: float, px: float, py: float, to_x: float | None = None, to_y: float | None = None) -> tuple[float, float]:
    """放大 k 倍，并把铺满时画布上 (px, py) 处的内容移到 (to_x, to_y)；返回画面的位移（像素，右、下为正）。"""
    to_x = W / 2 if to_x is None else to_x
    to_y = H / 2 if to_y is None else to_y
    return to_x - W / 2 - k * (px - W / 2), to_y - H / 2 - k * (py - H / 2)


def focus_in(k: float, px: float, py: float, to_x: float | None = None, to_y: float | None = None) -> tuple[float, float]:
    """同 focus，但把落点挪到画面不出界的位置：推近靠边的东西时，不露出画面外的黑边，
    也不露出录屏顶上被裁掉的状态栏（灵动岛上有录屏红点）。"""
    to_x, to_y = (W / 2 if to_x is None else to_x), (H / 2 if to_y is None else to_y)
    to_x = min(max(to_x, W - k * (W - px)), k * px)
    to_y = min(max(to_y, H - k * (H - py)), k * py)
    return focus(k, px, py, to_x, to_y)


class Camera:
    """整条时间线上的一条运镜路径：[(时间线秒, 放大倍数, 位移 x, 位移 y), ...]（位移单位是像素）。
    同一镜头被切成几段时，各段都用这条路径，镜头运动就能跨剪辑点连续。
    点与点之间：短于 0.7 秒的是「推过去」，用缓入缓出；长的是慢推，匀速。"""

    def __init__(self, pts: list[tuple[float, float, float, float]]):
        self.pts = sorted(pts)


# ---------- 品牌与片尾 ----------

@dataclass
class Brand:
    """一个项目的品牌参数，片尾按它来做。每个项目在 projects/<项目>/video/brand.py 里定义一个。"""
    name: str            # App 名：片尾大字，也是搜索框里打出来的词，如 "Packly"
    subtitle: str        # 片尾大字下面那行小字，如 "Packing List"
    materials: Path      # 原始素材目录 projects/<项目>/素材/（录屏、实拍、图标，不入库）
    video: Path          # 视频目录 projects/<项目>/video/
    icon: Path           # 原始 App 图标（1024 方图，自带圆角）
    bg: str              # 片尾底色
    ink: str             # 片尾大字颜色
    accent: str          # 小字和放大镜的颜色
    voice: str = "jessica"
    zh_font: Path | None = None   # 中文字体（带字重轴的可变字体）：屏幕上的汉字和片尾都用它；不给就只有 TikTok Sans
    outro_say: str | None = None  # 片尾口播；不给就是「<App 名>. Search it on the App Store.」
    cta: str = "Search it on the App Store"  # 片尾搜索框下面那行字
    slogan: str | None = None     # 片尾 2 在 App 名下面那句文案；不给就用副标题
    follow_say: str | None = None  # 片尾 3 的口播（美食号「关注我，带你找好店」）；画面不变，仍是 slogan；不给就不能用片尾 3
    outro_style: int = 1          # 默认用哪个片尾：1 带 App Store 搜索框；2 只有图标、名字和文案（美食号 10-21 起全用 2）；
                                  # 3 画面同 2，只把口播换成 follow_say，念完就收（美食号 10-22 起全用 3）
    cover_in_video: bool = False  # True：封面接在成片开头停 COVER_HEAD 秒，不另出 封面.jpg（截图放 预览/封面.jpg 只给总览当缩略图）；
                                  # 平台默认拿第一帧当封面，发布时不用手动传（美食号 11-07 负责人定）

    @property
    def exports(self) -> Path:
        """成片目录（不入库）：在项目根目录（10-22 负责人定，原来在 video/ 下太深），每条一个文件夹「<序号> <英文标题>」，
        里面是成片（文件名就是英文标题）、封面.jpg 和一份 发布文案.md（cover_in_video 的项目没有 封面.jpg，封面在成片开头）。"""
        return self.video.parent / "成片"

    @property
    def outro_parts(self) -> Path:
        """片尾口播等生成物（不入库）。"""
        return self.video / "00-片尾" / "零件"

    @property
    def outro_line(self) -> str:
        """片尾口播。各条视频自己的口播不再念这句。"""
        return self.outro_say or f"{self.name}. Search it on the App Store."


SAFE_BOTTOM = 1560  # 竖屏 TikTok 底部文案区的上沿（像素），关键内容不放到这以下；预检把这一带设成禁区

# 片尾版式（画布像素，纵向都在安全区 240–1260 之内）。App 名的 p 往下伸，和副标题之间留约 30 像素
# （原来只隔 2 像素、贴在一起，10-18 负责人提的：竖屏图标和名字上移 14、下面几样下移 14，横屏下面几样下移 28）
ENDCARD = {"icon_y": 586, "icon_px": 340, "name_y": 846, "sub_y": 959, "bar_y": 1104, "bar_w": 760, "bar_h": 124}
# 横屏（1920×1080）片尾：同样的元素整体往上收，箭头放在搜索框右上方
ENDCARD_LANDSCAPE = {"icon_y": 290, "icon_px": 250, "name_y": 512, "sub_y": 625, "bar_y": 763, "bar_w": 700, "bar_h": 116}
# 片尾 2（hf/片尾2.html）：只有图标、App 名、一句文案，三样整体放在画面中上部（竖屏纵向都在安全区 240–1260 之内）
ENDCARD2 = {"icon_y": 740, "icon_px": 330, "name_y": 1010, "name_px": 124, "slogan_y": 1146, "slogan_px": 54}
ENDCARD2_LANDSCAPE = {"icon_y": 330, "icon_px": 250, "name_y": 560, "name_px": 112, "slogan_y": 676, "slogan_px": 50}


def caption_name(video_dir: Path, section: str = "标题") -> str:
    """成片的文件名：发布文案.md「标题」代码块里的英文标题（钩子句 + 话题标签），负责人拿它当 TikTok 描述；
    中文配音版取「中文配音版标题」那一段（section）。去掉文件名里不能有的 / 和 :，总长不超过系统上限（macOS 文件名最多 255 字节）。"""
    block = (Path(video_dir) / "发布文案.md").read_text().split(f"## {section}", 1)[1].split("```", 2)[1]
    text = " ".join(line.strip() for line in block.splitlines() if line.strip())
    text = re.sub(r"\s+", " ", text.replace(": ", " - ").replace(":", " ").replace("/", " ")).strip()
    full = text
    while len((text + ".mp4").encode()) > 250:  # 先去掉末尾的话题标签，再按词截
        text = text[:text.rindex(" #")] if " #" in text else text[:text.rindex(" ")]
    if text != full:
        print(f"提醒：英文标题超过文件名上限，末尾「{full[len(text):].strip()}」没放进文件名；请把发布文案缩短到 250 字节以内")
    return text


# ---------- 文字排版 ----------

_FONTS: dict = {}
ZH_FONT: Path | None = None   # 当前项目的中文字体（建 Cut 时按品牌设置）；页面里的字体栈是 TikTok Sans 在前、它在后
_WIDE = re.compile(r"[⺀-鿿豈-﫿＀-￯]+")   # 汉字和全角标点：TikTok Sans 没有，页面上落到中文字体


def _font(px: float, weight: int, width: int = 100, zh: bool = False):
    """量字宽用的字体（与页面同一个字体文件、同一组轴）：TikTok Sans，汉字用品牌的中文字体。"""
    from PIL import ImageFont
    key = (round(px), weight, width, zh)
    if key not in _FONTS:
        if zh:
            f = ImageFont.truetype(str(ZH_FONT), round(px))
            f.set_variation_by_axes([weight])  # 只有 wght 一根轴
        else:
            f = ImageFont.truetype(str(FONT), round(px))
            f.set_variation_by_axes([36, width, weight, 0])  # opsz, wdth, wght, slnt
        _FONTS[key] = f
    return _FONTS[key]


def _text_w(s: str, px: float, weight: int, width: int = 100) -> float:
    if ZH_FONT is None or not _WIDE.search(s):
        return _font(px, weight, width).getlength(s)
    total, pos = 0.0, 0   # 中英混排：汉字一段段按中文字体量，其余按 TikTok Sans 量
    for m in _WIDE.finditer(s):
        total += _font(px, weight, width).getlength(s[pos:m.start()]) + _font(px, weight, zh=True).getlength(m.group())
        pos = m.end()
    return total + _font(px, weight, width).getlength(s[pos:])


def _zh_face() -> str:
    """中文字体的 @font-face（页面和片尾各写一份；没有中文字体就是空的）。"""
    if ZH_FONT is None:   # 英文项目也要声明一下：片尾和页面的字体栈里写着 "Zh Font"，不声明 lint 报错（10-20 一个英文项目的片尾踩到）
        return '@font-face { font-family: "Zh Font"; src: local("PingFang SC"); }'
    return (f'@font-face {{ font-family: "Zh Font"; src: url("assets/ZhFont{ZH_FONT.suffix.lower()}") '
            f'format("truetype"); font-weight: 200 900; font-style: normal; }}')


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _svg(name: str, **subs) -> str:
    """代码贴纸的 SVG 源码（去掉注释），直接内嵌进页面，里面带 class 的部件可以单独做动画。"""
    s = re.sub(r"<!--.*?-->", "", (STICKER_DIR / f"{name}.svg").read_text(), flags=re.S).strip()
    for k, v in subs.items():
        s = s.replace("{{" + k + "}}", v)
    return s


# ---------- 时间线 ----------

class Cut:
    def __init__(self, name: str, video_dir: Path, brand: Brand, *, message: str = ""):
        global ZH_FONT
        ZH_FONT = Path(brand.zh_font) if brand.zh_font else None
        self.name = name
        self.dir = Path(video_dir)
        self.brand = brand
        self.message = message
        self.proj = self.dir / "工程"
        self.parts = self.dir / "零件"
        self.assets: dict[str, Path] = {}          # 工程里的相对路径 → 源文件
        self.shots: list[dict] = []
        self.stage: list[dict] = []
        self.overlays: list[str] = []
        self.audios: list[str] = []
        self.plan = {"texts": [], "stickers": [], "fx": [], "confetti": []}
        self.outro_at: float | None = None
        self.outro_dur = 0.0
        self.outro_style = 1                      # 1：片尾.html（带搜索框）；2：片尾2.html（只有图标、名字和文案）；3：片尾2.html，口播换成 follow_say
        self.n = 0
        self.ends = [0.0]
        self._cover: Cover | None = None
        self.heads: list[str] = []    # 写进 <head> 的（样式表、脚本）
        self.layers: list[str] = []   # 画面层之上、文字贴纸之下的自定义 HTML（如代码画的手机界面）
        self.scenes: list[str] = []   # 这条视频自己的动画脚本（JS 函数，拿到同一条时间线和工具函数）
        self.data: dict = {}          # 给动画脚本的数据（window.__DATA）
        self.hits: list[tuple[float, str]] = []   # 各音效最响那一下的时刻（体检用）
        self.kits: list[str] = []                 # 用了哪些通用动画组件（c.use）
        self._bgm: dict | None = None             # 背景乐（c.bgm），渲染完、校响度之前混进去

    def bgm(self, path: Path, *, start: float = 0.0, lufs: float = -20.0, fade: float = 1.5) -> None:
        """整条铺一首背景乐：从曲子第 start 秒起放，单独调到 lufs，口播和音效一响就自动压低约 5 dB（侧链压缩），
        最后 fade 秒淡出。渲染完、整体校响度之前用 ffmpeg 混进去，所以成片响度照旧是 −16 LUFS。
        只有项目自己定了要背景乐才用（美食号 10-20 负责人定；别的项目成片里不放音乐，见仓库说明）。"""
        if not Path(path).exists():
            raise FileNotFoundError(f"背景乐不在：{path}")
        self._bgm = {"path": Path(path), "start": start, "lufs": lufs, "fade": fade}

    def _mix_bgm(self, video: Path) -> Path:
        b = self._bgm
        d = probe(video).duration
        gain = b["lufs"] - loudness(b["path"])[0]
        fc = (f"[1:a]atrim=start={b['start']:.3f},asetpts=PTS-STARTPTS,volume={gain:.2f}dB,aresample=48000,"
              f"afade=t=out:st={max(0.0, d - b['fade']):.3f}:d={b['fade']:.3f}[m];"
              "[0:a]aresample=48000,asplit=2[v][sc];"
              "[m][sc]sidechaincompress=threshold=0.06:ratio=2.5:attack=30:release=450:knee=6[md];"
              "[v][md]amix=inputs=2:normalize=0:duration=first[a]")
        out = video.with_name("out-bgm.mp4")
        run("ffmpeg", "-y", "-nostdin", "-i", video, "-i", b["path"], "-filter_complex", fc, "-map", "0:v", "-map", "[a]",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", out)
        return out

    def _id(self, prefix: str) -> str:
        self.n += 1
        return f"{prefix}{self.n}"

    def _asset(self, src: Path, name: str | None = None) -> str:
        src = Path(src)
        if name is None:
            key = hashlib.sha1(str(src.resolve()).encode()).hexdigest()[:8]
            name = f"{re.sub(r'[^A-Za-z0-9]+', '-', src.stem)[:24].strip('-') or 'media'}-{key}{src.suffix.lower()}"
        rel = f"assets/{name}"
        self.assets[rel] = src
        return rel

    # ---------- 画面 ----------

    def clip(self, src: Path, at: float, dur: float, *, src_in: float = 0.0, speed: float = 1.0,
             track: str = "main", scale: float = 1.0, x: float = 0.0, y: float = 0.0,
             cam: Camera | tuple[float, float] | None = None, bump: float = 0.0,
             transition: str | None = None, transition_dur: float = 0.3, intro: str | None = None,
             volume: float = 0.0) -> None:
        """放一段视频或图片，铺满画面（和剪映一样上下裁掉多出来的）。
        cam：运镜路径 Camera，或 (起, 止) 两个放大倍数的慢推；scale、x、y 是固定的缩放和位移（像素）。
        bump：片段开头一个冲击推镜（先放大 bump 倍再回落），用在快门、落地这类节拍上。
        transition：和同一轨道上紧接着的下一段之间的转场（TRANSITIONS 里的名字）。
        intro="渐显"：从透明淡入（盖在别的画面上时用）。volume 默认 0（素材原声都不要）。"""
        if transition and transition not in TRANSITIONS:
            raise ValueError(f"没有这种转场：{transition}，可选 {'、'.join(TRANSITIONS)}")
        if track not in TRACK_Z:
            raise ValueError(f"没有这条轨道：{track}，可选 {'、'.join(TRACK_Z)}")
        if isinstance(cam, tuple):
            cam = Camera([(at, cam[0], 0, 0), (at + dur, cam[1], 0, 0)])
        image = probe(src).is_image
        media = src if image or volume > 0 else proxy(src)  # 视频一律用关键帧密的代理（带原声的片尾这类除外）
        self.shots.append({"src": self._asset(media), "path": Path(src), "at": at, "dur": dur, "src_in": src_in,
                           "speed": speed, "track": track, "scale": scale, "x": x, "y": y, "cam": cam,
                           "bump": bump, "transition": TRANSITIONS.get(transition), "td": transition_dur,
                           "intro": intro, "volume": volume, "image": image})
        self.ends.append(at + dur)

    def punch(self, at: float, amount: float = 0.06) -> None:
        """在 at 处给整个画面一个冲击推镜（先放大再回落），用在快门、落地这类节拍上。"""
        self.stage.append({"type": "punch", "t": at, "dur": 0.6, "amp": amount})

    # ---------- 叠在画面上的 ----------

    def fx(self, name: str, at: float, dur: float, params: list[float] | None = None, *,
           x_px: float | None = None, y_px: float | None = None) -> None:
        """特效（FX 里的名字）。画面层的（震动、心跳、推镜、摇晃运镜）作用于整个画面；叠加层的在画面之上、
        文字和贴纸之下。聚光灯、虚线圈的中心用 x_px、y_px（画布像素）；虚线圈的 params[0] 是圈的大小。"""
        if name not in FX:
            raise ValueError(f"没有这种特效：{name}，可选 {'、'.join(FX)}")
        x_px = W / 2 if x_px is None else x_px
        y_px = H / 2 if y_px is None else y_px
        for layer, kind in FX[name]:
            if layer == "stage":
                amp = {"punch": 0.12}.get(kind, 1.0)
                self.stage.append({"type": kind, "t": at, "dur": dur if kind != "punch" else 0.6, "amp": amp})
            elif layer == "confetti":
                self.confetti(at, dur=min(max(dur, 1.2), 1.8))
            else:
                self._overlay(kind, at, dur, params, x_px, y_px)

    def _overlay(self, kind: str, at: float, dur: float, params, cx: float, cy: float) -> None:
        fid = self._id("fx")
        if kind in ("flash", "crossflash", "vflash", "shockwave"):
            dur = {"flash": 0.4, "crossflash": 0.45, "vflash": 0.45, "shockwave": 0.6}[kind] if kind != "flash" else min(dur, 0.4)
        inner = ""
        if kind == "vignette":
            inner = ('<div class="fx-in" style="background: radial-gradient(ellipse at 50% 46%, rgba(10,14,12,0) 42%, '
                     'rgba(10,14,12,0.62) 100%)"></div>')
        elif kind == "spotlight":
            inner = (f'<div class="fx-in fx-spot" style="--cx:{cx:.0f}px; --cy:{cy:.0f}px; --r:400px"></div>')
        elif kind == "flash":
            inner = '<div class="fx-in" style="background:#FFFFFF"></div>'
        elif kind == "speedlines":
            lines = []
            for i in range(32):
                a = 2 * math.pi * i / 32 + 0.07 * math.sin(i * 7.1)
                r0 = 470 + 120 * ((i * 37) % 7) / 7
                lines.append(f'<path class="sl" d="M{540 + 1250 * math.cos(a):.0f} {960 + 1250 * math.sin(a):.0f} '
                             f'L{540 + r0 * math.cos(a):.0f} {960 + r0 * math.sin(a):.0f}" '
                             f'stroke-width="{6 + (i * 13) % 9}"/>')
            inner = (f'<svg class="fx-in" viewBox="0 0 {W} {H}" width="{W}" height="{H}"><g stroke="#FFFFFF" '
                     f'stroke-linecap="round" opacity="0.85">{"".join(lines)}</g></svg>')
        elif kind == "qmarks":
            spots = [(170, 520), (900, 470), (300, 1300), (820, 1220), (120, 900), (960, 860), (540, 1560),
                     (420, 640), (690, 1460), (240, 1660), (880, 1640), (620, 360)]
            colors = ["#FF5A5F", "#FFD23F", "#4ECDC4", "#FFFFFF", "#FF8A3D"]
            marks = "".join(
                f'<div class="qm" style="left:{x - 80}px; top:{y - 90}px"><svg viewBox="0 0 160 180" width="160" height="180">'
                f'<text x="80" y="150" text-anchor="middle" font-family="TikTok Sans" font-weight="900" '
                f'font-size="{150 - (i % 3) * 25}" fill="{colors[i % len(colors)]}" stroke="{INK}" stroke-width="10" '
                f'stroke-linejoin="round" paint-order="stroke">?</text></svg></div>' for i, (x, y) in enumerate(spots))
            inner = f'<div class="fx-in">{marks}</div>'
        elif kind == "shockwave":
            inner = (f'<div class="fx-in"><div class="sw-glow"></div><svg viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
                     f'<circle class="sw-ring" cx="{cx:.0f}" cy="{cy:.0f}" r="10" fill="none" stroke="#FFFFFF" '
                     f'stroke-width="40"/></svg></div>')
        elif kind == "vflash":
            inner = '<div class="fx-in"><div class="vf-band"></div></div>'
        elif kind == "crossflash":
            inner = (f'<div class="fx-in"><div class="xf" style="left:{cx - 700:.0f}px; top:{cy - 700:.0f}px">'
                     '<div class="xf-glow"></div><div class="xf-h"></div><div class="xf-v"></div></div></div>')
        elif kind == "glitter":
            pts = [(80 + (i * 389) % 920, 200 + (i * 547) % 1500) for i in range(26)]
            sp = "".join(
                f'<svg class="gl" viewBox="-50 -50 100 100" width="{34 + (i * 17) % 40}" height="{34 + (i * 17) % 40}" '
                f'style="left:{x}px; top:{y}px"><path d="M0 -46 C7 -7 7 -7 46 0 C7 7 7 7 0 46 C-7 7 -7 7 -46 0 '
                f'C-7 -7 -7 -7 0 -46 Z" fill="{("#FFD95A", "#FFF3B0", "#FFB703")[i % 3]}"/></svg>'
                for i, (x, y) in enumerate(pts))
            inner = f'<div class="fx-in">{sp}</div>'
        elif kind == "rays":
            beams = "".join(f'<div class="ray" style="left:{-200 + i * 300}px; width:{150 + (i % 2) * 90}px"></div>'
                            for i in range(5))
            inner = f'<div class="fx-in fx-rays">{beams}</div>'
        elif kind == "dashcircle":
            r = 200 + 3 * (params[0] if params else 60)
            inner = (f'<svg class="fx-in" viewBox="0 0 {W} {H}" width="{W}" height="{H}"><g class="dc" '
                     f'style="transform-origin:{cx:.0f}px {cy:.0f}px">'
                     f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="none" stroke="{INK}" stroke-width="16" '
                     f'stroke-dasharray="46 30" opacity="0.55"/>'
                     f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="none" stroke="#FFFFFF" stroke-width="9" '
                     f'stroke-dasharray="46 30"/></g></svg>')
        self.overlays.append(f'<div class="clip ov fx" id="{fid}" data-start="{at:.3f}" data-duration="{dur:.3f}" '
                             f'data-track-index="20" style="z-index:{Z_FX + self.n}">{inner}</div>')
        self.plan["fx"].append({"id": fid, "type": kind, "t": at, "dur": dur})

    def confetti(self, at: float, *, dur: float = 1.8, n: int = 40,
                 origins: list[tuple[float, float, float]] = ((70, 1480, -60), (1010, 1480, -120))) -> None:
        """撒花：从几个发射点（x, y, 朝向角度，-90 是正上方）往上喷，落下淡出。"""
        cid = self._id("cf")
        self.overlays.append(f'<div class="clip ov" id="{cid}" data-start="{at:.3f}" data-duration="{dur:.3f}" '
                             f'data-track-index="21" style="z-index:{Z_CONFETTI}"><div class="cf-field"></div></div>')
        self.plan["confetti"].append({"id": cid, "t": at, "dur": dur, "n": n, "origins": [list(o) for o in origins],
                                      "cone": 20, "speed": [1500, 2600], "g": 2200, "palette": CONFETTI,
                                      "seed": len(self.plan["confetti"]) + 1})

    def text(self, s: str, at: float, dur: float, *, y_px: float, x_px: float | None = None, size: float = 12.5,
             style: str = "label", intro: str = "rise", outro: str | None = "fade", loop: str | None = None,
             num: str | int | None = None) -> None:
        """屏幕文字。size 沿用剪映字号的量级（标签 12.5 左右，大标题 15–17）。
        style="label"：TikTok 原生的白底圆角字，num 给一个品牌色的编号圆点；
        其余是大标题（TITLE_STYLES：黄字、白字立体、蓝光、红黄、蓝黄），粗描边加立体投影，{花括号} 里的字换强调色，
        超宽自动缩到画面内。intro：pop 弹入 / rise 上浮 / slam 砸下 / slide 左滑入 / type 打字（标签用）/ cut；
        从第一帧开始的大标题第一帧就在（封面要有字）。outro：fade / shrink / slide / None。
        loop：bounce 跳 / float 飘 / swing 摇 / shake 抖。x_px、y_px 是文字中心。"""
        x_px = W / 2 if x_px is None else x_px
        if intro not in TEXT_INTROS or (loop and loop not in TEXT_LOOPS):
            raise ValueError(f"文字动画只有 {TEXT_INTROS}、循环 {TEXT_LOOPS}")
        tid = self._id("txt")
        if style == "label":
            px = size * 4.4
            lines = s.split("\n")
            widest = max(_text_w(line, px, 760) for line in lines)
            if widest > 900:
                px *= 900 / widest
            badge = f'<div class="lab-num">{_esc(str(num))}</div>' if num is not None else ""
            inner = (f'<div class="txt-in lab-in" style="font-size:{px:.1f}px">{badge}'
                     f'<div class="lab-txt" data-full="{_esc(s)}">{_esc(s)}</div><span class="lab-caret"></span></div>')
            kind = "label"
        else:
            fill, stroke, shadow, hi, glow = TITLE_STYLES[style]
            lines = s.split("\n")
            px = size * 7.6
            widest = max(_text_w(re.sub(r"[{}]", "", line), px, 900, 94) for line in lines)
            if widest + px * 0.34 > 1000:
                px *= 1000 / (widest + px * 0.34)
            lh = round(px * 1.14)
            rows = []
            for line in lines:
                spans = "".join(f'<tspan fill="{hi}">{_esc(p[1:-1])}</tspan>' if p.startswith("{") else _esc(p)
                                for p in re.split(r"(\{[^}]*\})", line) if p)
                plain = _esc(re.sub(r"[{}]", "", line))
                common = (f'x="{W // 2}" y="{round(lh * 0.8)}" text-anchor="middle" font-family="TikTok Sans, Zh Font" '
                          f'font-weight="900" font-size="{px:.0f}" style="font-stretch: 94%" stroke-linejoin="round"')
                back = (f'<text {common} fill="{shadow}" stroke="{shadow}" stroke-width="{px * 0.2:.0f}" '
                        f'transform="translate(0 {px * 0.09:.0f})">{plain}</text>') if shadow else ""
                glow_f = f' filter="url(#glow-{tid})"' if glow else ""
                rows.append(f'<div class="ttl-line" style="height:{lh}px"><svg viewBox="0 0 {W} {lh}" width="{W}" '
                            f'height="{lh}">{back}<text {common} fill="{fill}" stroke="{stroke}" '
                            f'stroke-width="{px * 0.17:.0f}" paint-order="stroke"{glow_f}>{spans}</text></svg></div>')
            defs = (f'<svg width="0" height="0" style="position:absolute"><filter id="glow-{tid}" x="-20%" y="-40%" '
                    f'width="140%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="{px * 0.12:.0f}" '
                    f'flood-color="{glow}" flood-opacity="0.95"/></filter></svg>') if glow else ""
            inner = f'<div class="txt-in ttl" style="width:{W}px">{defs}{"".join(rows)}</div>'
            kind = "title"
        left, justify = (x_px, "flex-start") if num is not None else (x_px - W / 2, "center")
        self.overlays.append(
            f'<div class="clip ov" id="{tid}" data-start="{at:.3f}" data-duration="{dur:.3f}" data-track-index="30" '
            f'style="z-index:{Z_TEXT + self.n}"><div class="txt-pos" style="left:{left:.0f}px; top:{y_px - 400:.0f}px; '
            f'justify-content:{justify}"><div class="txt-loop">{inner}</div></div></div>')
        self.plan["texts"].append({"id": tid, "t": at, "end": at + dur, "kind": kind, "intro": intro,
                                   "outro": outro, "loop": loop})

    def label(self, num: str | int, text: str, at: float, dur: float, *, y: float = 300, x: float = 64) -> None:
        """编号要点标签：白底圆角，左边一个品牌深绿的编号圆点；靠左贴边（x 是左边缘），从左边滑进来。"""
        self.text(text, at, dur, y_px=y, x_px=x, size=13.2, intro="slide", outro="slide", num=num)

    def sticker(self, name: str, at: float, dur: float, *, x_px: float, y_px: float, size_px: float,
                rotation: float = 0.0, act: str | None = None, act_at: float | None = None,
                pop: bool | None = None) -> None:
        """代码贴纸（代码贴纸/<name>.svg，白色描边 + 投影的贴纸样式），按画布像素定位中心，size_px 是贴纸框宽度。
        act 默认取 STICKER_ACTS（ring 闹钟响 / shutter 按快门 / swing 摆 / draw 一笔描出来 / drop 落下 / burst 喷纸屑 …），
        act_at 是动作发生的时刻（默认弹出后）。"""
        sid = self._id("stk")
        act = act or STICKER_ACTS.get(name)
        pop = (name not in NO_POP) if pop is None else pop
        origin = STICKER_ORIGIN.get(name, "50% 50%")
        self.overlays.append(
            f'<div class="clip ov" id="{sid}" data-start="{at:.3f}" data-duration="{dur:.3f}" data-track-index="40" '
            f'style="z-index:{Z_STICKER + self.n}"><div class="stk" style="left:{x_px - size_px / 2:.0f}px; '
            f'top:{y_px - size_px / 2:.0f}px; width:{size_px:.0f}px; height:{size_px:.0f}px"><div class="stk-idle">'
            f'<div class="stk-act" style="transform-origin:{origin}">{_svg(name)}</div></div></div></div>')
        self.plan["stickers"].append({"id": sid, "t": at, "end": at + dur, "rot": rotation, "act": act, "pop": pop,
                                      "actAt": act_at if act_at is not None else at + (0.35 if pop else 0.05)})
        self.ends.append(at + dur)

    def cutout(self, png: Path, at: float, dur: float, *, x_px: float, y_px: float, size_px: float = 220,
               rotation: float = 0.0, pop: bool = True, wiggle: bool = False, plain: bool = False) -> None:
        """透明 PNG 贴图（抠好的物品、裁下来的卡片），按画布像素定位中心，size_px 是宽度，默认弹出入场。
        plain=True：原样贴上（不加投影、不浮动，放在特效层下面，暗角、聚光灯照样压得住），
        配合 card(shadow=False, radius=0) 和同色底图，把 App 里的东西挪个位置。"""
        m = probe(png)
        h = size_px * m.h / m.w
        sid = self._id("cut")
        self.overlays.append(
            f'<div class="clip ov" id="{sid}" data-start="{at:.3f}" data-duration="{dur:.3f}" data-track-index="35" '
            f'style="z-index:{(Z_FX - 100 if plain else Z_CUT) + self.n}"><div class="stk" '
            f'style="left:{x_px - size_px / 2:.0f}px; top:{y_px - h / 2:.0f}px; width:{size_px:.0f}px; height:{h:.0f}px">'
            f'<div class="stk-idle"><div class="stk-act"><img class="cut-img{" plain" if plain else ""}" '
            f'src="{self._asset(png)}" alt="" /></div></div></div></div>')
        self.plan["stickers"].append({"id": sid, "t": at, "end": at + dur, "rot": rotation, "plain": plain,
                                      "act": "wiggle" if wiggle else None, "pop": pop and not plain,
                                      "actAt": at + 0.35})

    # ---------- 声音 ----------

    def audio(self, src: Path, at: float, *, dur: float | None = None, src_in: float = 0.0, volume: float = 1.0,
              fade: tuple[float, float] | None = None, **_) -> None:
        """一段声音（口播、音效）。dur 不给就放到文件结束；fade 是 (淡入, 淡出) 秒数。声音各占一条轨道。"""
        aid = self._id("aud")
        d = (probe(src).duration - src_in) if dur is None else dur
        extra = f' data-fade-in="{fade[0]:.2f}" data-fade-out="{fade[1]:.2f}"' if fade else ""
        self.audios.append(f'<audio id="{aid}" src="{self._asset(src)}" data-start="{at:.3f}" data-duration="{d:.3f}" '
                           f'data-media-start="{src_in:.3f}" data-volume="{volume:.3f}" '
                           f'data-track-index="{100 + len(self.audios)}"{extra}></audio>')

    def sfx(self, name: str, at: float, volume: float | None = None, *, peak: bool = False, semis: int = 0) -> None:
        """音效。不给音量就用 SFX_VOLUME 里的默认值。peak=True：音效最响那一下落在 at（落地、点按、盖章、碰撞这类
        打点都用它，不用再手动提前）；默认是文件开头放在 at（时钟滴答、环境声这类铺底的）。
        semis：升降几个半音，一串事件一个比一个高用 semis=H.step(k)。"""
        path, volume = sfx(name), SFX_VOLUME.get(name, 0.35) if volume is None else volume
        if semis:
            path = pitched(path, semis)
        self.hits.append((at if peak else max(0.0, at) + sfx_peak(path), name))   # 体检里列出各音效最响那一下的时刻
        if not peak:
            self.audio(path, max(0.0, at), volume=volume)
            return
        start = at - sfx_peak(path)   # 太靠前放不下时，从文件中间起放，峰值仍落在 at
        self.audio(path, max(0.0, start), src_in=max(0.0, -start), volume=volume)

    # ---------- 片尾 ----------

    def outro(self, at: float, *, line: str | None = None, voice: str | None = None, style: int | None = None) -> float:
        """在 at 处接通用片尾（hf/片尾.html），返回片尾时长。底色渐显盖住前一个镜头：
        前一段素材要多留 0.25 秒垫在渐显下面。片尾自带口播「<App 名>. Search it on the App Store.」和音效；
        中文配音版等要换一句时给 line 和 voice（另存一份，不覆盖默认那句）。
        style=2 换成片尾 2（hf/片尾2.html）：只有图标、App 名和 brand.slogan，没有搜索框、箭头和 CTA（10-21 先在美食号试）。
        style=3 是片尾 3：画面和片尾 2 一样，只把口播换成 brand.follow_say，口播一念完就结束（10-22 负责人手剪定的长度）。
        不给 style 就用品牌的 outro_style。"""
        style = style or self.brand.outro_style
        if style not in (1, 2, 3):
            raise ValueError(f"片尾只有 1、2、3 三种：{style}")
        if style == 3 and not self.brand.follow_say:
            raise ValueError("片尾 3 要在 brand.py 里给 follow_say")
        self.outro_style = style
        line = line or (self.brand.follow_say if style == 3 else self.brand.outro_line)
        voice = voice or self.brand.voice
        name = ("片尾口播.mp3" if (line, voice) == (self.brand.outro_line, self.brand.voice)
                else f"片尾口播-{voice}-{hashlib.sha1(line.encode()).hexdigest()[:6]}.mp3")
        vo = tts(line, self.brand.outro_parts / name, voice=voice)
        self.outro_at, self.outro_dur = at, round(vo.duration + 1.05, 3)
        if style == 3:   # 口播从片尾第 0.15 秒起（模板里的 data-start），说完再留 0.05 秒：美食号剪出来 2.1 秒
            self.outro_dur = round(0.15 + vo.quiet_after(vo.words[-1].start) + 0.05, 3)
        self._asset(vo.path, "outro-vo.mp3")
        self._asset(self.brand.icon, "icon.png")
        for s in ("whoosh", "pop", "chime"):
            self._asset(sfx(s), f"sfx-{s}.mp3")
        return self.outro_dur

    def _outro_html(self) -> str:
        if self.outro_style in (2, 3):
            return self._outro2_html()
        e, b = (ENDCARD_LANDSCAPE if W > H else ENDCARD), self.brand
        values = {
            "W": W, "H": H, "DUR": f"{self.outro_dur}", "BG": b.bg, "INK": b.ink, "ACCENT": b.accent, "NAME": b.name,
            "SUBTITLE": b.subtitle, "ICON_PX": e["icon_px"], "ICON_L": (W - e["icon_px"]) // 2,
            "ICON_T": e["icon_y"] - e["icon_px"] // 2, "NAME_T": e["name_y"] - 60, "SUB_T": e["sub_y"] - 23,
            "BAR_L": (W - e["bar_w"]) // 2, "BAR_T": e["bar_y"] - e["bar_h"] // 2, "BAR_W": e["bar_w"],
            # 箭头在副标题右边、TikTok 右侧按钮列左边，箭头尖落在搜索框上沿
            "BAR_H": e["bar_h"], "BAR_R": e["bar_h"] // 2, "CTA_T": e["bar_y"] + 104,
            "ARROW_L": 730 if W < H else W // 2 + e["bar_w"] // 2 - 120,
            "ARROW_T": e["bar_y"] - 210, "ARROW_SVG": _svg("箭头"),
            "GLOW_L": W // 2 - 450, "GLOW_T": e["icon_y"] - 390,  # 900 见方的光晕，罩在图标和名字后面
            "ZH_FACE": _zh_face(), "CTA": _esc(b.cta),
        }
        s = (HF / "片尾.html").read_text()
        return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values[m.group(1)]), s)

    def _outro2_html(self) -> str:
        e, b = (ENDCARD2_LANDSCAPE if W > H else ENDCARD2), self.brand
        slogan = b.slogan or b.subtitle
        # 字号按宽度封顶：长文案缩到画面宽的 80% 以内，不折行
        name_px = min(e["name_px"], e["name_px"] * W * 0.8 / max(_text_w(b.name, e["name_px"], 850), 1))
        slogan_px = min(e["slogan_px"], e["slogan_px"] * W * 0.8 / max(_text_w(slogan, e["slogan_px"], 650), 1))
        name_h, slogan_h = round(name_px * 1.3), round(slogan_px * 1.4)
        values = {
            "W": W, "H": H, "DUR": f"{self.outro_dur}", "BG": b.bg, "INK": b.ink, "ACCENT": b.accent,
            "NAME": _esc(b.name), "SLOGAN": _esc(slogan), "ICON_PX": e["icon_px"], "ICON_L": (W - e["icon_px"]) // 2,
            "ICON_T": e["icon_y"] - e["icon_px"] // 2, "NAME_PX": f"{name_px:.1f}", "NAME_H": name_h,
            "NAME_T": e["name_y"] - name_h // 2, "SLOGAN_PX": f"{slogan_px:.1f}", "SLOGAN_H": slogan_h,
            "SLOGAN_T": e["slogan_y"] - slogan_h // 2, "GROUP_OY": (e["icon_y"] + e["slogan_y"]) // 2,
            "GLOW_L": W // 2 - 450, "GLOW_T": e["icon_y"] - 390, "ZH_FACE": _zh_face(),
        }
        s = (HF / "片尾2.html").read_text()
        return re.sub(r"\{\{(\w+)\}\}", lambda m: str(values[m.group(1)]), s)

    # ---------- 自定义层与动画脚本（代码画的界面、横屏视频） ----------

    def folder(self, src: Path, name: str) -> str:
        """整个目录（含子目录）链接进工程的 assets/<name>/，返回页面里引用它的前缀（如 "assets/fp/"）。"""
        src = Path(src)
        for f in sorted(src.rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                self.assets[f"assets/{name}/{f.relative_to(src).as_posix()}"] = f
        return f"assets/{name}/"

    def head(self, html: str) -> None:
        """往 <head> 里加东西（<link rel=stylesheet>、<script src>），路径用 folder() 返回的前缀。"""
        self.heads.append(html)

    def layer(self, html: str, z: int = 600) -> None:
        """一层自定义 HTML，铺满画布，层级 z（画面 100–799、特效 1000、文字 1300、贴纸 1400、片尾 2000）。"""
        self.layers.append(f'<div class="layer" style="position:absolute;inset:0;z-index:{z}">{html}</div>')

    def use(self, *names: str) -> None:
        """载入 hf/组件/ 里的通用动画组件（"动效" 小工具、"老虎机"、"撒花"……），挂在场景里的 window.KIT 上。
        组件都按时间算状态，各条视频共用；"动效" 是别的组件的底子，总是先载入。"""
        for n in ("动效", *names):
            if n in self.kits:
                continue
            self.kits.append(n)
            js = HF / "组件" / f"{n}.js"
            self.head(f'<script src="{self._asset(js, f"kit/{n}.js")}"></script>')

    def scene(self, js: str) -> None:
        """这条视频自己的动画：一段 JS 函数源码 function (api) {...}，可以返回 Promise（比如先等图片加载完）。
        api 里有 tl（主时间线）、fromTo、drive、q、qa、prand、easeIO、sin、env、W、H、DATA；
        规矩同 runtime.js：只用 fromTo 和 drive，画面只由时间决定。"""
        self.scenes.append(js)

    # ---------- 封面 ----------

    def cover(self) -> Cover:
        """这条视频的封面（一张 1080×1920 的图），用法同 Cut，只是不写时间，见 Cover。render() 时一起出图。"""
        self._cover = Cover(self)
        return self._cover

    def _folder(self) -> tuple[Path, str]:
        """成片文件夹「<序号> <英文标题>」（序号取视频目录名前面的数字，方便按顺序上传）和英文标题。
        发布文案改了标题时，同一序号的旧文件夹移到废纸篓；10-18 以前直接放在 成片/ 下的成片挪进来。
        这条的 发布文案.md 每次都复制一份进去（10-22 负责人定：发布时在成片旁边就能找到标题和文案）。"""
        title = caption_name(self.dir)
        m = re.match(r"(\d+)-", self.dir.name)
        exports = self.brand.exports
        folder = exports / (f"{m.group(1)} {title}" if m else title)
        if m:
            for old in exports.glob(f"{m.group(1)} *"):
                if old.is_dir() and old != folder:
                    print(f"提醒：标题改了，旧文件夹「{old.name[:40]}…」移到废纸篓")
                    _trash(old)
        folder.mkdir(parents=True, exist_ok=True)
        flat = exports / f"{title}.mp4"
        if flat.exists() and not (folder / flat.name).exists():
            flat.replace(folder / flat.name)
        shutil.copyfile(self.dir / "发布文案.md", folder / "发布文案.md")
        return folder, title

    # ---------- 生成工程 ----------

    def total(self) -> float:
        if self.outro_at is not None:
            return round(self.outro_at + self.outro_dur, 3)
        return round(max(self.ends), 3)

    def _windows(self) -> tuple[list[dict], list[dict]]:
        """各段在时间线上的窗口和转场。有重叠的转场跨在剪辑点两边：视频本身不越过剪辑点，
        重叠的那一半用静帧垫着（前一段的最后一帧、后一段的第一帧）。转场接的是同一轨道上紧接着的下一段。"""
        shots = [dict(s, k=k, stills=[]) for k, s in enumerate(self.shots)]
        trans = []
        for a in shots:
            if not a["transition"]:
                continue
            t = a["at"] + a["dur"]
            b = next((s for s in shots if s["track"] == a["track"] and abs(s["at"] - t) < 0.02 and s is not a), None)
            if b is None:
                raise ValueError(f"第 {a['k'] + 1} 段的转场接不上：同一轨道上 {t:.2f} 秒没有下一段")
            half = a["td"] / 2
            kind = a["transition"]
            if kind == "shake":
                self.stage.append({"type": "shake", "t": t, "dur": 0.3, "amp": 1.0})
                continue
            if kind in OVERLAP:
                last = a["src_in"] + a["dur"] * a["speed"] - 1 / FPS
                a["stills"].append((self._asset(_tail_still(a["path"], last)), t, half))
                b["stills"].append((self._asset(_tail_still(b["path"], b["src_in"])), t - half, half))
            trans.append({"i": len(trans), "a": a["k"], "b": b["k"], "type": kind, "t": t, "d": a["td"]})
        return shots, trans

    def save(self) -> Path:
        shots, trans = self._windows()
        total = self.total()
        order: dict[str, int] = {}
        shot_html = []
        for s in shots:
            n = order[s["track"]] = order.get(s["track"], 0) + 1
            z = TRACK_Z[s["track"]] + 99 - min(n, 99)  # 同一轨道上前面的在上面（转场时前一段盖着后一段走）
            src, start, dur = s["src"], s["at"], s["dur"]
            fixed = ""
            if s["cam"] is None and (s["scale"] != 1.0 or s["x"] or s["y"]):
                fixed = f' style="transform: translate({s["x"]:.1f}px, {s["y"]:.1f}px) scale({s["scale"]:.4f})"'
            if s["image"]:
                media = (f'<img class="media clip" id="v{s["k"]}" src="{src}" alt="" data-start="{start:.3f}" '
                         f'data-duration="{dur:.3f}" data-track-index="{s["k"] % 2}" />')
            else:
                audio = (f'data-has-audio="true" data-volume="{s["volume"]:.3f}"' if s["volume"] > 0 else "muted")
                media = (f'<video class="media" id="v{s["k"]}" src="{src}" data-start="{start:.3f}" '
                         f'data-duration="{dur:.3f}" data-media-start="{s["src_in"]:.3f}" '
                         f'data-playback-rate="{s["speed"]:.4f}" data-track-index="{s["k"] % 2}" {audio} playsinline></video>')
            stills = "".join(f'<img class="media clip" id="st{s["k"]}-{i}" src="{a}" alt="" data-start="{t:.3f}" '
                             f'data-duration="{d:.3f}" data-track-index="2" />' for i, (a, t, d) in enumerate(s["stills"]))
            shot_html.append(f'<div class="shot" id="shot{s["k"]}" style="z-index:{z}"><div class="cam" id="cam{s["k"]}"{fixed}>'
                             f'<div class="bump" id="bump{s["k"]}">{media}{stills}</div></div></div>')
        trans_html = []
        for tr in trans:
            if tr["type"] == "flash":
                inner = '<div class="tr-flash"></div>'
            elif tr["type"] == "shutter":
                inner = '<div class="tr-sh-top"></div><div class="tr-sh-bot"></div>'
            else:
                continue
            trans_html.append(f'<div class="clip ov" id="tro{tr["i"]}" data-start="{tr["t"] - tr["d"] / 2:.3f}" '
                              f'data-duration="{tr["d"]:.3f}" data-track-index="22" style="z-index:{Z_TRANS}">{inner}</div>')
        blur_filters = "".join(f'<filter id="tr{tr["i"]}" x="-5%" y="-5%" width="110%" height="110%">'
                               f'<feGaussianBlur stdDeviation="0 0" edgeMode="duplicate"/></filter>' for tr in trans)
        outro_host = ""
        if self.outro_at is not None:
            outro_host = (f'<div id="outro-host" data-composition-id="outro" data-composition-src="compositions/outro.html" '
                          f'data-start="{self.outro_at:.3f}" data-duration="{self.outro_dur:.3f}" data-width="{W}" '
                          f'data-height="{H}" data-track-index="50" style="position:absolute; inset:0; z-index:{Z_OUTRO}"></div>')
        self._asset(FONT, "TikTokSans.ttf")
        if ZH_FONT is not None:
            self._asset(ZH_FONT, f"ZhFont{ZH_FONT.suffix.lower()}")
        plan = {"W": W, "H": H, "total": total,
                "shots": [{"k": s["k"], "start": s["at"], "end": s["at"] + s["dur"], "bump": s["bump"],
                           "intro": s["intro"], "cam": [list(p) for p in s["cam"].pts] if s["cam"] else None}
                          for s in shots],
                "transitions": trans, "stage": self.stage, **self.plan}
        html = (HF / "页面.html").read_text()
        html = (html.replace("{{TITLE}}", _esc(self.name)).replace("{{W}}", str(W)).replace("{{H}}", str(H))
                .replace("{{GSAP}}", GSAP).replace("{{TOTAL}}", f"{total:.3f}").replace("{{INK}}", INK)
                .replace("{{PAPER}}", PAPER).replace("{{BRAND_INK}}", self.brand.ink).replace("{{ZH_FACE}}", _zh_face())
                .replace("{{FILTERS}}", blur_filters)
                .replace("{{HEAD}}", "\n".join(self.heads))
                .replace("{{BODY}}", "\n".join(shot_html + ["</div>"] + self.layers + trans_html + self.overlays + [outro_host]
                                               + self.audios))
                .replace("{{SCENES}}", "window.__DATA = " + json.dumps(self.data, ensure_ascii=False) + ";\nwindow.__SCENES = ["
                         + ",\n".join(self.scenes) + "];")
                .replace("{{PLAN}}", json.dumps(plan, ensure_ascii=False))
                .replace("{{RUNTIME}}", (HF / "runtime.js").read_text()))
        p = self.proj
        (p / "assets").mkdir(parents=True, exist_ok=True)
        (p / "compositions").mkdir(exist_ok=True)
        for rel, src in self.assets.items():  # 素材硬链接进工程（同一块盘不占空间），已有的不动
            dst = p / rel
            if dst.exists() and dst.stat().st_size == src.stat().st_size and dst.stat().st_mtime >= src.stat().st_mtime:
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.unlink(missing_ok=True)
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)
        for old in (p / "assets").iterdir():  # 以前用过、这次没用到的素材删掉（都是硬链接或副本，源文件不受影响）
            if old.is_file() and f"assets/{old.name}" not in self.assets:
                old.unlink()
        (p / "index.html").write_text(html)
        if self.outro_at is not None:
            (p / "compositions" / "outro.html").write_text(self._outro_html())
        (p / "hyperframes.json").write_text(json.dumps({
            "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
            "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
            "paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"},
            "media": {"autoProxy": True}, "authoringSkill": "general-video"}, indent=2) + "\n")
        (p / "BRIEF.md").write_text(self._brief(total))
        return p

    def _brief(self, total: float) -> str:
        """HyperFrames 插件读的项目说明：这个工程由脚本生成，按 general-video 自动出片、不先出分镜。"""
        return (f"---\nworkflow: general-video\nflow: automation\nstoryboard: no\n"
                f"message: {json.dumps(self.message or self.name, ensure_ascii=False)}\ndestination: tiktok\n"
                f"aspect: {W}x{H}\nlanguage: en\nlength: {total:.1f}s\n---\n\n## Intent\n\n{self.name}。本工程由 "
                f"video-kit/hfcut.py 按上一级目录的 build.py 生成，每次运行都会重写；要改就改 build.py。\n\n## Notes\n\n"
                f"- {'TikTok 竖屏' if H > W else 'X、Reddit 横屏'} {W}×{H}、30 帧。不加字幕、不用 emoji；屏幕上只有标题、要点标签和代码贴纸。\n"
                "- 不用任何剪映素材：贴纸在 video-kit/代码贴纸/，动画在 video-kit/hf/runtime.js。\n"
                "- 关键内容避开 TikTok 界面：顶部约 200 px、右侧 900 px 以右的按钮列、底部 1560 px 以下的文案区。\n")

    # ---------- 渲染 ----------

    def _preflight(self, marks: list[float] | None) -> Path:
        """渲染前预检（python build.py 预检，约一分钟）：不渲整片，按 marks 的时刻出静帧拼图 预览/预检.jpg（没给 marks 就
        均匀取 9 帧），再跑 hyperframes check（各动画起止点也采样）。只列三类：脚本报错；我们自己加的字（标题、编号标签，
        工程里是 #txt…）和别的字叠在一起、出了画面；字压进 TikTok 底部的文案区。界面还原本身的提示（页面切换时新旧两页
        本来就叠着、透明的特效画布被算成遮挡）只计数；对比度不查（iOS 的浅灰字本来就过不了 WCAG，标题有描边）。
        返回一个不存在的路径：build.py 里排在 render() 后面的出封面之类的步骤就不会跑。"""
        p = self.save()
        lint = _hf("lint", p)
        errors = re.findall(r"✗ .*", lint.stdout + lint.stderr)
        if errors:
            raise RuntimeError("lint 有错误：\n" + "\n".join(errors[:10]))
        shots, sheet = self.dir / "预览" / "预检", self.dir / "预览" / "预检.jpg"
        shutil.rmtree(shots, ignore_errors=True)
        at = ["--at", ",".join(f"{max(0.0, t):.2f}" for t in marks)] if marks else []
        _hf("snapshot", p, *(at or ["--frames", "9"]), "--no-end", "--describe", "false", "--output", shots)
        frames = sorted(shots.glob("frame-*.png"))
        stamps = [re.search(r"at-([\d.]+)s", f.name).group(1) for f in frames]
        # 格子上标第几张和时刻（标签字体 TikTok Sans 没有中文，单位写 s）
        _tile(frames, sheet, labels=[f"{k + 1}   {s}s" for k, s in enumerate(stamps)])
        # check 默认只回 80 条，透明特效画布的「遮挡」误报会把真问题挤掉（10-18 FP14），上限放大
        args = ["check", p, "--json", "--at-transitions", "--max-transition-samples", "80", "--max-issues", "2000",
                "--no-contrast", *at]
        if H > W:
            args += ["--caption-zone", f"x0=0;y0={SAFE_BOTTOM / H:.4f};x1=1;y1=1;severity=error"]
        rep = json.loads(subprocess.run([str(HF_BIN), *map(str, args)], capture_output=True, text=True, env=ENV).stdout)
        ours = re.compile(r"#txt\d+")
        found, skipped = [], 0
        for f in rep["runtime"]["findings"] + rep["layout"]["findings"]:
            where = f"{f.get('selector', '')} {f.get('containerSelector', '')}"
            if f in rep["runtime"]["findings"] or f["code"] == "caption_zone_collision" or ours.search(where):
                times = f.get("times") or [f.get("time", 0)]
                found.append(f"  {times[0]:6.2f}–{times[-1]:6.2f} 秒  {f['code']}：「{(f.get('text') or '').strip()[:24]}」"
                             f"{f['message']}")
            else:
                skipped += 1
        report = (rep.get("saved") or {}).get("report")
        print(f"预检：静帧 {sheet.relative_to(self.dir)}；我们的字和脚本有 {len(found)} 处要看，界面还原本身的提示 {skipped} 条略过"
              + (f"（完整报告 {Path(report).relative_to(self.dir)}）" if report else ""))
        print("\n".join(found))
        return sheet.with_suffix(".未渲染")

    def render(self, marks: list[float] | None = None, *, out: Path | None = None, title: str | None = None) -> Path:
        """生成工程、lint、渲染，响度校正到 −16 LUFS、真峰值不超过 −1 dBTP（画面不重新编码），成片放进 成片/<序号> <标题>/
        （文件名是发布文案的英文标题；给了 title 就用它，如中文配音版，还放在同一个文件夹里），写了封面的同时出 封面.jpg，
        再出抽帧拼图和体检（单帧跳变、静止段、各音效最响那一下的时刻）供自检；marks 给的时刻另拼一张 关键帧.jpg。
        命令行带「封面」（python build.py 封面）时只出封面，不渲染视频；带「预检」时只出静帧和检查，见 _preflight。"""
        if "预检" in sys.argv[1:]:   # 预检不碰成片文件夹（标题改了也不挪旧文件夹）
            return self._preflight(marks)
        if out is None:
            folder, en = self._folder()
            out = folder / f"{title or en}.mp4"
        out = Path(out)
        cover = None
        if self._cover:
            if self.brand.cover_in_video:   # 封面接进成片开头，成片文件夹里不留 封面.jpg
                cover = self.dir / "预览" / "封面.jpg"
                cover.parent.mkdir(exist_ok=True)
                out.with_name("封面.jpg").unlink(missing_ok=True)
                self._cover.snap(cover)
            else:
                self._cover.snap(out.with_name("封面.jpg"))
        if "封面" in sys.argv[1:]:
            return out
        p = self.save()
        lint = _hf("lint", p)
        errors = re.findall(r"✗ .*", lint.stdout + lint.stderr)
        if errors:
            raise RuntimeError("lint 有错误：\n" + "\n".join(errors[:10]))
        tmp = p / "renders" / "out.mp4"
        tmp.parent.mkdir(exist_ok=True)
        _hf("render", p, "--output", tmp, "--fps", FPS, "--sdr", "--quiet")  # 一律普通动态范围（TikTok 用 H.264 SDR）
        if self._bgm:
            self._mix_bgm(tmp).replace(tmp)
        # HyperFrames 把单声道的口播、音效原样复制到左右声道，整段比剪映版响约 1.6 LU（10-18 实测，各段比例不变）。
        # 渲染完量一次，整体校正到口播的目标响度，再用限幅器把峰值压在 -1 dBFS 以下（只有音效的片子
        # 拉到 -16 LUFS 时尖峰会顶到 -0.4，10-18 FP08）；画面不重新编码。AAC 编码会冒出样点之间的峰值，
        # 编码后量真峰值，超过 -1 dBTP 就把限幅压到 -2 dBFS 再编一次（10-18 对标后定）
        i, _ = loudness(tmp)
        fixed = tmp.with_name("out-loudness.mp4")
        for limit in (0.89, 0.79):
            run("ffmpeg", "-y", "-nostdin", "-i", tmp, "-map", "0", "-c:v", "copy", "-af",
                f"volume={VO_LUFS - i:.2f}dB,alimiter=limit={limit}:attack=4:release=60:level=0:latency=1",
                "-c:a", "aac", "-b:a", "192k", "-shortest", fixed)
            if loudness(fixed)[1] <= -1.0:
                break
        fixed.replace(tmp)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(tmp, out)
        i, peak = loudness(out)
        print(f"成片：{out.name}（{probe(out).duration:.2f} 秒，响度 {i:.1f} LUFS，真峰值 {peak:.1f} dBTP）")
        sheets(out, self.dir / "预览", marks=marks)
        health(out, self.dir / "预览", body_end=self.outro_at, hits=self.hits,
               cuts=[x["at"] for x in self.shots if x["track"] == "main"])   # 主轨每段画面的起点：体检只在这些切点附近查闪帧
        if cover:
            cover_head(out, cover)
            print(f"封面接在成片开头 {COVER_HEAD} 秒（抽帧、体检的时刻不含这一段）")
        return out


class Cover(Cut):
    """封面：一张 1080×1920 的图（JPG，放进成片文件夹），用法同 Cut，只是不写时间：clip 铺底图、cutout 放卡片、
    text 写标题、sticker 加贴纸、fx 加暗角之类。文字默认没有入场动画，贴纸不弹出；cam 可以只给 (倍数, 位移x, 位移y)，
    定住一个取景。TikTok 主页网格和上传封面时只露出中间 3:4（y 240–1680），标题和主体都放在 y 300–1560 之内；
    左上角会盖「置顶」标，左下角会盖播放数，那两处别放字。"""
    T = 2.0   # 合成的长度
    AT = 1.6  # 截图的时刻：入场、描线都已完成，贴纸还没退场

    def __init__(self, cut: Cut):
        super().__init__(f"{cut.name} 封面", cut.dir, cut.brand, message=cut.message)
        self.proj = cut.dir / "封面工程"
        self.ends = [self.T]

    def clip(self, src: Path, **kw) -> None:
        cam = kw.get("cam")
        if isinstance(cam, tuple) and len(cam) == 3:
            kw["cam"] = Camera([(0.0, *cam), (self.T, *cam)])
        super().clip(src, 0.0, self.T, **kw)

    def text(self, s: str, **kw) -> None:
        kw.setdefault("intro", "cut")
        kw.setdefault("outro", None)
        super().text(s, 0.0, self.T, **kw)

    def sticker(self, name: str, **kw) -> None:
        kw.setdefault("pop", False)
        super().sticker(name, 0.0, self.T, **kw)

    def cutout(self, png: Path, **kw) -> None:
        kw.setdefault("pop", False)
        super().cutout(png, 0.0, self.T, **kw)

    def fx(self, name: str, **kw) -> None:
        super().fx(name, 0.0, self.T, **kw)

    def snap(self, out: Path) -> Path:
        """生成工程（封面工程/，每次重写，不入库），截 AT 那一帧，存成 JPG。"""
        from PIL import Image
        p = self.save()
        shots = p / "renders"
        _hf("snapshot", p, "--at", f"{self.AT}", "--no-end", "--describe", "false", "--output", shots)
        Image.open(next(shots.glob("frame-*.png"))).convert("RGB").save(out, quality=92)
        print(f"封面：{out.parent.name[:24]}…/{out.name}")
        return out


def cover_head(video: Path, cover: Path, hold: float = COVER_HEAD) -> None:
    """把封面图接在成片最前面停 hold 秒，声音整体往后让 hold 秒，原地改写（Brand.cover_in_video 的项目 render() 自动调；
    旧成片补封面也用它，只能跑一次）。平台默认拿第一帧当封面，发布时就不用另传；只停一帧会像闪帧，所以停一小会儿。"""
    tmp = video.with_name(video.stem + "-封面头.mp4")
    ms = round(hold * 1000)
    run("ffmpeg", "-y", "-nostdin", "-loop", "1", "-framerate", FPS, "-t", f"{hold}", "-i", cover, "-i", video,
        "-filter_complex", f"[0:v]scale={W}:{H},setsar=1,format=yuv420p[c];[1:v]setsar=1,format=yuv420p[m];"
                           f"[c][m]concat=n=2:v=1:a=0,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709[v];"
                           f"[1:a]adelay={ms}:all=1[a]",
        "-map", "[v]", "-map", "[a]", "-r", FPS, "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp)
    tmp.replace(video)


def health(video: Path, out_dir: Path, *, body_end: float | None = None,
           hits: list[tuple[float, str]] | None = None, cuts: list[float] | None = None) -> Path:
    """成片体检，写进 out_dir/体检.txt，并打一行摘要。把七项里「有没有空拍」「声画同步」变成能看的数：
    - 单帧跳变：某一帧和前后两帧都差得多，前后两帧彼此却差不多（只闪了一帧）；
    - 切点闪帧：两个剪辑点只隔 1–2 帧，中间那一两帧是别的画面（10-20 评审查出：横屏拼接换算舍到上一帧，切点先闪上一段的尾巴）；
    - 静止段：连续 0.5 秒以上画面几乎不动（body_end 之后的片尾不算），另算正片里静止的总时长；
    - 音效时刻：hits 给的各音效最响那一下落在第几秒，对着抽帧看声画对不对。
    逐帧缩成 160 宽的灰度小图比较，40 秒的片子几秒钟。"""
    from PIL import Image, ImageChops, ImageStat
    m = probe(video)
    sw, sh = 160, round(160 * m.h / m.w / 2) * 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(video), "-vf", f"scale={sw}:{sh},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    size = sw * sh
    frames = [Image.frombytes("L", (sw, sh), raw[k * size:(k + 1) * size]) for k in range(len(raw) // size)]
    diff = lambda a, b: ImageStat.Stat(ImageChops.difference(a, b)).mean[0]   # noqa: E731  平均每个像素差多少（0–255）
    d = [0.0] + [diff(frames[k - 1], frames[k]) for k in range(1, len(frames))]
    end = len(frames) if body_end is None else min(len(frames), int(body_end * FPS))
    pops = [k / FPS for k in range(1, end - 1)
            if min(d[k], d[k + 1]) > HEALTH["pop"] and min(d[k], d[k + 1]) > 3 * max(diff(frames[k - 1], frames[k + 1]), 1.0)]
    cut = lambda k: 0 < k < len(d) and d[k] > HEALTH["cut"]   # noqa: E731
    flashes = [k / FPS for k in range(2, end - 2)
               if cut(k) and not cut(k - 1) and (
                   (cut(k + 1) and not cut(k + 2)) or                    # 闪 1 帧
                   (not cut(k + 1) and cut(k + 2) and not cut(k + 3)))   # 闪 2 帧
               and k / FPS not in pops
               # 给了切点就只查切点前后 3 帧：手持晃动、手快速挥过、标题缩走这类镜头内的快动作不算（10-21：竖屏原片误报很多）
               and (cuts is None or any(abs(k / FPS - c) <= 3 / FPS for c in cuts))]
    still, run_from = [], None
    for k in range(1, end + 1):
        if k < end and d[k] < HEALTH["still"]:
            run_from = k if run_from is None else run_from
            continue
        if run_from is not None and (k - run_from) / FPS >= 0.5:
            still.append(((run_from - 1) / FPS, (k - 1) / FPS))
        run_from = None
    total = sum(b - a for a, b in still)
    lines = [f"体检：{Path(video).name}", "",
             f"单帧跳变 {len(pops)} 处" + ("：" + "、".join(f"{t:.2f}" for t in pops[:20]) if pops else ""),
             f"切点闪帧 {len(flashes)} 处" + ("：" + "、".join(f"{t:.2f}" for t in flashes[:20]) if flashes else "")
             + "（两个剪辑点只隔 1–2 帧；上甩这类有意的快动作也可能报，对着抽帧看）",
             f"静止 0.5 秒以上 {len(still)} 段，正片里合计 {total:.1f} 秒（每 30 秒约 {total * 30 / max(end / FPS, 1):.1f} 秒；"
             "超过 1 秒的要么是有意的停顿，要么加慢推或微呼吸）"]
    lines += [f"  {a:6.2f}–{b:6.2f}（{b - a:.1f} 秒）" for a, b in still]
    if hits:
        lines += ["", "各音效最响那一下的时刻（对着抽帧看声画对不对）："]
        lines += [f"  {t:6.2f}  {name}" for t, name in sorted(hits)]
    out = Path(out_dir) / "体检.txt"
    out.write_text("\n".join(lines) + "\n")
    print(f"体检：单帧跳变 {len(pops)} 处，切点闪帧 {len(flashes)} 处，静止 0.5 秒以上 {len(still)} 段（正片合计 {total:.1f} 秒），"
          f"详见 {out.parent.name}/体检.txt")
    return out


# 体检的门槛（平均每个像素的灰度差，0–255，160 宽小图）：跳变那一帧和前后两帧都要差这么多；低于 still 算几乎不动
HEALTH = {"pop": 6.0, "still": 0.25, "cut": 12.0}   # cut：算一个剪辑点的帧差


def _tile(images: list[Path], out: Path, *, labels: list[str] | None = None, width: int = 360, cols: int = 8) -> Path:
    """几张图拼成一张（每格 width 宽，每行 cols 格），labels 写在每格上方。"""
    from PIL import Image, ImageDraw
    ims = [Image.open(p).convert("RGB") for p in images]
    w, h = width, round(ims[0].height * width / ims[0].width)
    cols, pad, bar = min(cols, len(ims)), 6, 28 if labels else 0
    rows = -(-len(ims) // cols)
    sheet = Image.new("RGB", (cols * (w + pad) + pad, rows * (h + bar + pad) + pad), "white")
    draw = ImageDraw.Draw(sheet)
    for k, im in enumerate(ims):
        x, y = pad + k % cols * (w + pad), pad + k // cols * (h + bar + pad)
        if labels:
            draw.text((x + 4, y + 4), labels[k], fill=INK, font=_font(19, 700))
        sheet.paste(im.resize((w, h)), (x, y + bar))
    sheet.save(out, quality=88)
    return out


def sheets(video: Path, out_dir: Path, *, every: float = 1.5, marks: list[float] | None = None) -> list[Path]:
    """抽帧拼图：每 every 秒一帧，一张原尺寸的一半（看细节），一张手机尺寸（360 宽，看字读不读得清）；
    marks 给的时刻再拼一张 关键帧.jpg（每格右上角不标时刻，按给的顺序排）。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    n = int(probe(video).duration / every) + 1
    cols = min(n, 6)
    rows = -(-n // cols)
    res = []
    for name, width in (("抽帧.jpg", 540), ("手机尺寸.jpg", 360)):
        dst = out_dir / name
        run("ffmpeg", "-y", "-nostdin", "-i", video, "-vf",
            f"fps={1 / every:.4f},scale={width}:-1,tile={cols}x{rows}:padding=6:color=white", "-frames:v", "1",
            "-q:v", "3", dst)
        res.append(dst)
    if marks:
        frames = out_dir / "关键帧"
        shutil.rmtree(frames, ignore_errors=True)
        frames.mkdir()
        for k, t in enumerate(marks):
            run("ffmpeg", "-y", "-nostdin", "-ss", f"{max(0.0, t):.3f}", "-i", video, "-frames:v", "1",
                "-vf", "scale=360:-1", frames / f"{k:02d}.png")
        cols = min(len(marks), 8)
        dst = out_dir / "关键帧.jpg"
        run("ffmpeg", "-y", "-nostdin", "-pattern_type", "glob", "-i", frames / "*.png", "-vf",
            f"tile={cols}x{-(-len(marks) // cols)}:padding=6:color=white", "-frames:v", "1", "-q:v", "3", dst)
        shutil.rmtree(frames, ignore_errors=True)
        res.append(dst)
    return res
