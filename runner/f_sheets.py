#!/usr/bin/env python3
"""前端复现评分用的对照帧图：从并排视频（原录屏 | 甲 | 乙，f2_sbs.py 生成）按时间点抽帧，每张图 6 个时间点（2 列 × 3 行），
左上角标时间。动画段抽得密、静止段抽得疏，翻页前后最密。给评分的人（或模型）逐张看动效的先后、快慢和落点。
用法：python3 f_sheets.py <并排视频.mp4> <输出目录> [F1|F2]
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

STEPS = {
    # F1：0–2.6 第 1 步开演，6.45 第一次点，7.0–8.4 第 2 步开演，11.55 第二次点，12.1–14.5 第 3 步开演
    'F1': [(0.0, 2.6, 0.2), (4.0, 4.0, 1), (6.2, 6.2, 1), (6.4, 7.2, 0.1), (7.4, 9.6, 0.2), (10.0, 11.5, 0.5),
           (11.5, 12.2, 0.1), (12.4, 14.4, 0.2), (14.8, 16.0, 0.4)],
    # F2（按 f2_sbs.py 对齐后的原录屏时间轴）：1.62 点 Clothing，2.74 点 Home，4.70 再点 Home 取消，5.60 上滑，
    # 7.22 点 Bedroom 进详情（入场动画约 1 秒），9.33 左边缘右滑返回，12.0 结束
    'F2': [(0.4, 0.4, 1), (1.5, 2.4, 0.1), (2.6, 3.5, 0.1), (4.0, 4.0, 1), (4.6, 5.4, 0.1), (5.5, 7.0, 0.25),
           (7.1, 8.8, 0.1), (9.2, 10.4, 0.1), (11.0, 11.9, 0.45)],
}


def times(kind):
    out = []
    for a, b, st in STEPS[kind]:
        t = a
        while t <= b + 1e-6:
            out.append(round(t, 2))
            t += st
    return sorted(set(out))


def frame(video, t, path):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', video, '-frames:v', '1', path], check=True)
    return Image.open(path).convert('RGB')


def main(video, outdir, kind='F1'):
    os.makedirs(outdir, exist_ok=True)
    ts = times(kind)
    from f2_sbs import font
    f = font(26)
    per = 6
    for s in range(0, len(ts), per):
        group = ts[s:s + per]
        cells = []
        for t in group:
            im = frame(video, t, os.path.join(outdir, '_f.png'))
            im = im.resize((im.width // 2, im.height // 2))
            d = ImageDraw.Draw(im)
            d.rectangle([0, 0, 110, 36], fill=(200, 30, 30))
            d.text((8, 2), f'{t:.2f}s', fill=(255, 255, 255), font=f)
            cells.append(im)
        w, h = cells[0].size
        sheet = Image.new('RGB', (w * 2 + 8, h * 3 + 16), (255, 255, 255))
        for i, c in enumerate(cells):
            sheet.paste(c, ((i % 2) * (w + 8), (i // 2) * (h + 8)))
        sheet.save(os.path.join(outdir, f'sheet-{s // per + 1:02d}.jpg'), quality=85)
    os.remove(os.path.join(outdir, '_f.png'))
    print(len(ts), 'frames ->', (len(ts) + per - 1) // per, 'sheets')


if __name__ == '__main__':
    main(*sys.argv[1:])
