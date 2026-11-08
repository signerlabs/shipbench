# 自动剪辑参照录屏：从 App 启动时刻起，找第一帧亮画面（启动画面或首屏），跳过主屏幕、启动缩放和冷启动黑屏
import subprocess, sys
from PIL import Image, ImageChops, ImageStat
S, R = sys.argv[1], sys.argv[2]
END_ADJ = {'fm-onboarding': -2.5, 'trovy-report': 0.8}
for n, adj in END_ADJ.items():
    m = dict(l.split() for l in open(f'{S}/{n}.marks'))
    rec, launch, end = float(m['rec']), float(m['launch']), float(m['end'])
    base = max(launch - rec - 0.5, 0)
    w, h, fps = 33, 72, 10
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{base:.2f}', '-i', f'{S}/{n}-raw.mp4', '-t', '40',
                          '-vf', f'fps={fps},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                         capture_output=True).stdout
    frames = [Image.frombytes('L', (w, h), raw[i:i + w * h]) for i in range(0, len(raw) - w * h + 1, w * h)]
    start = base
    for i, f in enumerate(frames):
        if ImageStat.Stat(f).mean[0] > 200:
            start = base + i / fps - 0.1
            break
    stop = end - rec + adj
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.2f}', '-i', f'{S}/{n}-raw.mp4', '-t', f'{stop - start:.2f}',
                    '-r', '30', '-c:v', 'libx264', '-crf', '22', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-an', f'{R}/{n}.mp4'], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{R}/{n}.mp4', '-vf', 'fps=1/2.5,scale=200:-1,tile=9x2:padding=6:color=white',
                    '-frames:v', '1', f'{S}/{n}-sheet.png'], check=True)
    print(f'{n}：App 出现在录屏第 {start:.1f} 秒，成片 {stop - start:.1f} 秒')
