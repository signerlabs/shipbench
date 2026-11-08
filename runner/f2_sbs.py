#!/usr/bin/env python3
"""前端复现盲评用的并排视频（环境变量 FTASK=F1 时按 F1 的方式对齐）：原录屏 | 甲 | 乙。
用法：uv run --with pillow python3 f2_sbs.py <原录屏.mp4> <输出.mp4> <甲-raw.mp4> <甲.marks> [<乙-raw.mp4> <乙.marks> ...]

各家的回放录屏按 .marks 里 shot:k1 的时刻对齐到原录屏的第 1 秒（原录屏第 1.3 秒点第一下，回放在拍完 k1 后点第一下），
剪到 shot:k7 后 0.8 秒；短的停在最后一帧补齐。先把每段单独转成 440 宽、30 帧、等长的小片，再横向拼接、顶上加一条标签。
"""
import os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

W, H, BAND, FPS = 440, 956, 56, 30
TAIL = float(os.environ.get('TAIL', '1.5'))  # F1：各家第 3 步之后多留的秒数，原录屏停在最后一帧


def marks(p):
    m = {}
    for line in open(p):
        k, v = line.split()
        m[k] = float(v)
    return m


def font(size):
    for f in ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf']:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def first_frame_with_button(path, t0, t1):
    """录屏里第一次出现底部绿色按钮（屏高 0.92 处横向一大片品牌绿）的时刻；找不到就当 App 在 launch 后 1 秒出画面"""
    import numpy as np
    w, h = 66, 143
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{max(t0, 0):.2f}', '-to', f'{t1:.2f}', '-i', path, '-vf', f'fps=10,scale={w}:{h}',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    fr = np.frombuffer(raw, np.uint8)[:n * w * h * 3].reshape(n, h, w, 3).astype(int)
    row = fr[:, int(h * 0.922), int(w * 0.2):int(w * 0.8)]
    green = (row[..., 1] - row[..., 0] > 40) & (row[..., 1] - row[..., 2] > 10)
    hit = np.where(green.mean(1) > 0.6)[0]
    return max(t0, 0) + (hit[0] / 10 if len(hit) else 1.0)


def f1_events(path):
    """F1 回放录屏里三件事的时刻（按视频自己的时间轴，不靠墙上时间）：App 出画面、第一次点按、第二次点按。
    模拟器录屏在画面静止时不出帧，视频会比实际经过的时间短（11-08 Codex 那段短了约 30 秒），所以不能拿 .marks 的墙上时间直接换算。
    出画面 = 底部第一次出现整片品牌绿按钮；点按 = 顶部进度条第 2、3 段开始变橙（原录屏校准：点按后约 0.05 秒开始填）。找不到返回 None"""
    import numpy as np
    w, h = 132, 287
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'fps=30,scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True).stdout
    n = len(raw) // (w * h * 3)
    fr = np.frombuffer(raw, np.uint8)[:n * w * h * 3].reshape(n, h, w, 3).astype(int)
    btn = fr[:, int(h * 0.922), int(w * 0.2):int(w * 0.8)]
    green = ((btn[..., 1] - btn[..., 0] > 40) & (btn[..., 1] - btn[..., 2] > 10)).mean(1) > 0.6
    bar = fr[:, int(h * 0.094) - 1:int(h * 0.094) + 2]
    org = ((bar[..., 0] > 200) & (bar[..., 1] > 100) & (bar[..., 1] < 170) & (bar[..., 2] < 110)).any(1)
    seg2 = org[:, int(w * 0.43):int(w * 0.60)].mean(1) > 0.15
    seg3 = org[:, int(w * 0.66):int(w * 0.83)].mean(1) > 0.15
    def first(mask, after=0):
        idx = np.where(mask[after:])[0]
        return after + int(idx[0]) if len(idx) else None
    a = first(green)
    t1 = first(seg2, a or 0)
    t2 = first(seg3, t1 or 0) if t1 is not None else None
    return tuple(None if x is None else x / 30 for x in (a, t1, t2))


def run(*a):
    subprocess.run(['nice', '-n', '10', 'ffmpeg', '-nostdin', '-v', 'error', '-y', *a], check=True)


def main(ref, out, *pairs):
    tmp = tempfile.mkdtemp()
    names = os.environ['FNAMES'].split(',') if os.environ.get('FNAMES') else ['原录屏', '甲', '乙', '丙', '丁']  # FNAMES 可改标签（逗号分隔）
    clips = [(ref, 0.0, float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ref],
                                              capture_output=True, text=True).stdout.strip()))]
    for i in range(0, len(pairs), 2):
        m = marks(pairs[i + 1])
        # 录屏的时间轴约等于「墙上时间 − rec」；画面静止时模拟器不出新帧，结尾静止的部分会被截掉，起点超出就退到最后一帧
        vd = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', pairs[i]],
                                  capture_output=True, text=True).stdout.strip())
        if os.environ.get('FTASK', 'F2') == 'F1':
            # F1 分三段对齐（11-08 改，按画面内容找时刻）：① App 出画面起 6.45 秒（第 1 步入场动画）；② 第一次点按起 5.1 秒（第 2 步）；
            # ③ 第二次点按起到原录屏结尾，再多留 TAIL 秒（第 3 步，动画慢的也能看到演完）。原录屏两次点按在 6.45、11.55 秒。
            # 回放时两次点按的间隔被截图耗时拉长，且录屏静止时不出帧，所以每段各自对齐；找不到事件时退回按 .marks 估算
            a, t1, t2 = f1_events(pairs[i])
            if a is None or t1 is None or t2 is None:
                tap = m['shot:k1'] - m['rec'] + 0.35
                a = first_frame_with_button(pairs[i], m['launch'] - m['rec'], tap) if a is None else a
                t1 = tap if t1 is None else t1 + 0.05
                t2 = (m['shot:k2'] - m['rec'] + 0.35) if t2 is None else t2 + 0.05
                print(pairs[i], '没从画面找全事件，部分按 .marks 估算', file=sys.stderr)
            else:
                t1, t2 = t1 - 0.05, t2 - 0.05
            print(pairs[i], f'出画面 {a:.2f}s 第一次点 {t1:.2f}s 第二次点 {t2:.2f}s（视频时间）', file=sys.stderr)
            end = max(vd - 1.0, 0)
            clips.append((pairs[i], [(min(a, end), 6.45), (min(t1, end), 5.1), (min(t2, end), clips[0][2] - 11.55 + TAIL)], clips[0][2] + TAIL))
        else:
            clips.append((pairs[i], min(m['shot:k1'] - m['rec'] - 1.0, vd - 0.2), m['shot:k7'] - m['shot:k1'] + 1.8))
    total = max(c[2] for c in clips)
    frames = int(total * FPS)
    parts = []
    for j, (path, start, dur) in enumerate(clips):
        p = os.path.join(tmp, f'c{j}.mp4')
        if isinstance(start, list):
            # 分段：每段先各自转成小片（短的停在最后一帧补齐到该段长度），再接起来
            segs = []
            for n, (ss, d) in enumerate(start):
                sp = os.path.join(tmp, f'c{j}s{n}.mp4')
                # -ss 放在 -i 后面：从头解码到这个时刻再取，慢一点但准。模拟器录屏是变帧率、关键帧很稀，
                # 放在 -i 前面快速跳转会取错画面（11-08 xhigh 批 Claude Code 那段跳到 48.9 秒取出来的还是主屏幕）
                run('-i', path, '-ss', f'{max(ss, 0):.2f}', '-t', f'{d:.2f}',
                    '-vf', f'fps={FPS},scale={W}:{H},setsar=1,tpad=stop_mode=clone:stop_duration={d:.2f}',
                    '-frames:v', str(int(round(d * FPS))), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', sp)
                segs.append(sp)
            lst = os.path.join(tmp, f'c{j}.txt')
            open(lst, 'w').write(''.join(f"file '{x}'\n" for x in segs))
            joined = os.path.join(tmp, f'c{j}j.mp4')
            run('-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined)
            path, start, dur = joined, 0.0, dur
        run('-i', path, '-ss', f'{max(start, 0):.2f}', '-t', f'{dur:.2f}',
            '-vf', f'fps={FPS},scale={W}:{H},setsar=1,tpad=stop_mode=clone:stop_duration={total:.2f}',
            '-frames:v', str(frames), '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', p)
        parts.append(p)
        if os.environ.get('PARTS_DIR'):
            # 另存每一路对齐好的单独视频（网页里分开放、同时播放用）：part0 是原录屏，之后按传入顺序
            run('-i', p, '-c:v', 'libx264', '-crf', '26', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
                os.path.join(os.environ['PARTS_DIR'], f'part{j}.mp4'))
    n = len(parts)
    band = Image.new('RGB', (W * n, BAND), (24, 24, 24))
    d = ImageDraw.Draw(band)
    f = font(30)
    for j in range(n):
        tw = d.textlength(names[j], font=f)
        d.text((j * W + (W - tw) / 2, 10), names[j], fill=(255, 255, 255), font=f)
    bp = os.path.join(tmp, 'band.png')
    band.save(bp)
    ins = sum((['-i', p] for p in parts), [])
    filt = ''.join(f'[{j}:v]' for j in range(n)) + f'hstack=inputs={n}[h];[h]pad={W * n}:{H + BAND}:0:{BAND}[p];[p][{n}:v]overlay=0:0[o]'
    run(*ins, '-i', bp, '-filter_complex', filt, '-map', '[o]', '-frames:v', str(frames),
        '-c:v', 'libx264', '-crf', '26', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out)
    print(out, f'{total:.1f}s')


if __name__ == '__main__':
    main(*sys.argv[1:])
