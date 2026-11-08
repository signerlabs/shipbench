#!/usr/bin/env python3
"""前端复现（F2、F1；环境变量 FTASK 选题号）的自动分：把回放截图和原录屏同一状态的帧逐张比相似度。
用法：uv run --with pillow --with numpy python3 f2_score.py <参照帧目录> <空白基线截图目录> <待测截图目录>...

每张图先裁掉状态栏（顶部 6%），再算两样：
- 结构相似度 SSIM（灰度、缩到 1/8、7×7 窗口）：版式、文字、线条的位置
- 颜色接近度（缩到 1/40 后逐像素 RGB 平均差）：配色和色块
两样各占一半得到原始相似度，再用「什么都没做的空白工程」当 0 分、原录屏自己当 100 分线性换算。
"""
import json, os, sys
import numpy as np
from PIL import Image

STATES = {
    'F2': {'k1': '首屏', 'k2': '选中 Clothing', 'k3': '选中 Home', 'k4': '取消选中', 'k5': '往下滚', 'k6': 'Bedroom 详情', 'k7': '返回报表页'},
    'F1': {'k1': '第 1 步演完', 'k2': '第 2 步演完', 'k3': '第 3 步演完'},
    'F3': {'k1': '首屏', 'k2': '主推翻到下一张', 'k3': '滚回顶部再翻一张', 'k4': '再翻一张'},
}
_FT = os.environ.get('FTASK', 'F2')  # 环境变量 FTASK 选题号，默认 F2
_SF = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tasks', _FT, 'states.json')
# 新题把状态名写在 tasks/<题号>/states.json（{"k1": "首屏", ...}），不用改这里
STATE = json.load(open(_SF)) if os.path.exists(_SF) else STATES[_FT]
KEYS = list(STATE)


def load(p, size):
    im = Image.open(p).convert('RGB')
    w, h = im.size
    im = im.crop((0, int(h * 0.06), w, h))
    return np.asarray(im.resize(size, Image.BILINEAR), dtype=np.float64)


def box(a, k=7):
    # k×k 均值滤波（积分图），只取完整窗口
    c = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), 0), 1)
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def ssim(x, y):
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mx, my = box(x), box(y)
    sxx = box(x * x) - mx * mx
    syy = box(y * y) - my * my
    sxy = box(x * y) - mx * my
    s = ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx * mx + my * my + C1) * (sxx + syy + C2))
    return float(s.mean())


def gray(a):
    return a @ np.array([0.299, 0.587, 0.114])


def raw_sim(pa, pb):
    a, b = load(pa, (165, 337)), load(pb, (165, 337))
    s = ssim(gray(a), gray(b))
    ca, cb = load(pa, (33, 67)), load(pb, (33, 67))
    color = 1 - float(np.abs(ca - cb).mean()) / 255 * 4  # 平均差 64（满幅的四分之一）以上算完全不像
    return 0.5 * max(s, 0) + 0.5 * max(color, 0), s, color


def score(ref, blank, cand):
    rows = []
    for k in KEYS:
        pr, pb, pc = (os.path.join(d, k + '.png') for d in (ref, blank, cand))
        if not os.path.exists(pc):
            rows.append({'key': k, 'state': STATE[k], 'score': 0, 'missing': True})
            continue
        base = raw_sim(pr, pb)[0]
        r, s, c = raw_sim(pr, pc)
        n = max(0.0, min(1.0, (r - base) / (1 - base))) * 100
        rows.append({'key': k, 'state': STATE[k], 'score': round(n, 1), 'raw': round(r, 3), 'ssim': round(s, 3), 'color': round(c, 3), 'blank_raw': round(base, 3)})
    return {'score': round(sum(r['score'] for r in rows) / len(rows), 1), 'shots': rows}


if __name__ == '__main__':
    ref, blank = sys.argv[1], sys.argv[2]
    for cand in sys.argv[3:]:
        r = score(ref, blank, cand)
        print(cand, r['score'], [x['score'] for x in r['shots']])
        json.dump(r, open(os.path.join(cand, '..', 'f2-score.json') if os.path.basename(cand) == 'shots' else os.path.join(cand, 'f2-score.json'), 'w'), ensure_ascii=False, indent=2)
