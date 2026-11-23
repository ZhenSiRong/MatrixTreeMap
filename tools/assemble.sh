#!/usr/bin/env bash
# assemble.sh <frames-dir> <out-basename> —— 把 record.mjs 的帧拼成 GIF + MP4，字幕烧在底部。
#
# 两个硬要求：
#   1. 尺寸必须统一且高度为偶数，否则 libx264 报 "height not divisible by 2" 直接失败；
#   2. 字幕要烧进画面——GIF 没有音轨，观众只能靠这一行字知道这一步在做什么。
set -euo pipefail

DIR="${1:?frames 目录}"
NAME="${2:?输出名}"
W="${W:-1000}"
FONT="${FONT:-/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc}"

python3 - "$DIR" "$NAME" "$W" "$FONT" <<'PY'
import json, subprocess, sys, pathlib, shutil

dir_, name, width, font = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
frames = json.loads(pathlib.Path(dir_, 'frames.json').read_text())
out = pathlib.Path(dir_, 'out')
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)

# 1) 等比缩到统一宽度；记下最高的一帧
sizes = []
for i, f in enumerate(frames):
    dst = out / f'raw_{i:02d}.png'
    subprocess.run(['convert', f['file'], '-resize', f'{width}x', str(dst)], check=True)
    h = int(subprocess.run(['identify', '-format', '%h', str(dst)], capture_output=True, text=True, check=True).stdout)
    sizes.append(h)

canvas_h = max(sizes)
canvas_h += canvas_h % 2          # libx264 要求偶数高度

# 2) 补到统一画布，再把字幕压到底部（先补再写字幕，字幕位置才稳定）
for i, f in enumerate(frames):
    src = out / f'raw_{i:02d}.png'
    dst = out / f'{i:02d}.png'
    cmd = ['convert', str(src), '-background', '#0b0f14', '-gravity', 'north',
           '-extent', f'{width}x{canvas_h + 56}']
    if f['caption']:
        cmd += ['-font', font, '-pointsize', '22', '-gravity', 'southwest',
                '-fill', 'white', '-undercolor', '#000000C8',
                '-annotate', '+24+18', f['caption']]
    cmd.append(str(dst))
    subprocess.run(cmd, check=True)
    src.unlink()

# 3) GIF
gif = ['convert', '-loop', '0']
for i, f in enumerate(frames):
    gif += ['-delay', str(max(4, round(f['hold'] / 10))), str(out / f'{i:02d}.png')]
gif += ['-layers', 'Optimize', str(out / f'{name}.gif')]
subprocess.run(gif, check=True)

# 4) MP4（12 fps，按每帧 hold 重复）
seq = out / 'seq'
if seq.exists():
    shutil.rmtree(seq)
seq.mkdir()
n = 0
for i, f in enumerate(frames):
    reps = max(1, round(f['hold'] / 83))
    data = (out / f'{i:02d}.png').read_bytes()
    for _ in range(reps):
        n += 1
        (seq / f's_{n:05d}.png').write_bytes(data)

subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-start_number', '1', '-framerate', '12',
                '-i', str(seq / 's_%05d.png'), '-vf', 'format=yuv420p', '-c:v', 'libx264',
                '-crf', '20', '-movflags', '+faststart', str(out / f'{name}.mp4')], check=True)
shutil.rmtree(seq)

gif_size = (out / f'{name}.gif').stat().st_size
mp4_size = (out / f'{name}.mp4').stat().st_size
print(f'✅ {name}: gif {gif_size//1024}KB / mp4 {mp4_size//1024}KB  ({canvas_h}px 高)')
PY
