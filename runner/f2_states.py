#!/usr/bin/env python3
"""F2 七个状态的对比图：每行一个状态，从左到右是原录屏、甲、乙。
用法：uv run --with pillow python3 f2_states.py <输出.jpg> <原录屏状态帧目录> <甲截图目录> [<乙截图目录> ...]"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

STATES = {'F2': ['首屏', '选中 Clothing', '选中 Home', '取消选中', '往下滚', 'Bedroom 详情', '返回报表页'],
          'F1': ['第 1 步 演完', '第 2 步 演完', '第 3 步 演完']}[os.environ.get('FTASK', 'F2')]
TW, TH, LW, GAP, HEAD = 300, 652, 120, 12, 52


def font(size):
    for f in ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc']:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


out, dirs = sys.argv[1], sys.argv[2:]
names = (os.environ['FNAMES'].split(',') if os.environ.get('FNAMES') else ['原录屏', '甲', '乙', '丙', '丁'])[:len(dirs)]  # FNAMES 可改列名（逗号分隔）
W = LW + len(dirs) * (TW + GAP)
H = HEAD + len(STATES) * (TH + GAP)
im = Image.new('RGB', (W, H), (255, 255, 255))
d = ImageDraw.Draw(im)
f, fs = font(30), font(24)
for j, n in enumerate(names):
    x = LW + j * (TW + GAP)
    d.text((x + (TW - d.textlength(n, font=f)) / 2, 8), n, fill=(20, 20, 20), font=f)
for i, s in enumerate(STATES):
    y = HEAD + i * (TH + GAP)
    # 状态名竖排太挤，分两行写在左栏
    words = s.split(' ')
    for k, w in enumerate(words):
        d.text((8, y + TH / 2 - 20 * len(words) + k * 34), w, fill=(80, 80, 80), font=fs)
    for j, dd in enumerate(dirs):
        p = os.path.join(dd, f'k{i + 1}.png')
        x = LW + j * (TW + GAP)
        if os.path.exists(p):
            t = Image.open(p).convert('RGB').resize((TW, TH), Image.LANCZOS)
            im.paste(t, (x, y))
        else:
            d.rectangle([x, y, x + TW, y + TH], outline=(200, 200, 200))
            d.text((x + 100, y + TH / 2), '没有截图', fill=(150, 150, 150), font=fs)
        d.rectangle([x, y, x + TW - 1, y + TH - 1], outline=(220, 220, 220))
im.save(out, quality=82)
print(out, im.size)
