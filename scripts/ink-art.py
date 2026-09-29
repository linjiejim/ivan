#!/usr/bin/env python3
"""
水墨插画的后期处理（设计系统「墨」，见 docs/design-system.md「插画」一节）。

生成的原图是「墨画在纸上」，纸色和界面的纸色对不上，深色模式下还要整体反相。两种处理：

  alpha   插画（空状态、404）：去掉纸色，只留墨与颜料，输出带透明通道的方形 WebP。
          放在任何表面上都没有底框；深色模式由 CSS（.ink-art）反相成「月下的墨」。
  flatten 整幅背景（登录页）：把接近纸色的像素拉平成同一个纸色，去掉纸纹竖条
          （深色模式反相后会被放大），墨和雾原样保留。

用法：
  python3 scripts/ink-art.py alpha   原图.png apps/web/src/assets/ink/xxx.webp [纸纹阈值，默认 0.045]
  python3 scripts/ink-art.py flatten 原图.png apps/web/src/assets/ink/xxx.webp

  有大片淡雾的画（lost.webp）阈值用 0.03，雾才不会被当成纸纹去掉。

依赖：Pillow（带 WebP）+ numpy。
"""

import sys

import numpy as np
from PIL import Image


def paper_color(a: np.ndarray, pct: float) -> np.ndarray:
    """四个角落的采样，取偏亮的一端当纸色"""
    c = np.concatenate(
        [a[:48, :48].reshape(-1, 3), a[:48, -48:].reshape(-1, 3),
         a[-48:, :48].reshape(-1, 3), a[-48:, -48:].reshape(-1, 3)]
    )
    return np.percentile(c, pct, axis=0)


def smoothstep(x: np.ndarray) -> np.ndarray:
    return x * x * (3 - 2 * x)


def to_alpha(src: str, dst: str, max_side: int = 520, floor: float = 0.045) -> None:
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64) / 255
    b = paper_color(a, 75)
    # 只取「比纸暗」的部分：墨和颜料都比纸暗；比纸亮的纸纹一律当纸
    dark = np.clip((b - a) / b, 0, 1).max(axis=2)
    # 软阈值：纸纹（floor 以下）消失，淡雾平滑地淡入
    alpha = np.clip(dark * smoothstep(np.clip((dark - floor) / 0.05, 0, 1)), 0, 1)
    safe = np.maximum(alpha, 1e-6)[..., None]
    fg = np.clip((a - (1 - alpha[..., None]) * b) / safe, 0, 1)
    fg[alpha == 0] = 0
    # 以画面为中心裁成方形，留 8% 边
    ys, xs = np.where(alpha > 0.06)
    side = max(ys.max() - ys.min(), xs.max() - xs.min())
    half = side // 2 + int(side * 0.08)
    cy, cx = (ys.min() + ys.max()) // 2, (xs.min() + xs.max()) // 2
    canvas = np.zeros((2 * half, 2 * half, 4))
    y0, y1 = max(0, cy - half), min(a.shape[0], cy + half)
    x0, x1 = max(0, cx - half), min(a.shape[1], cx + half)
    rgba = np.dstack([fg, alpha])
    canvas[y0 - (cy - half):y1 - (cy - half), x0 - (cx - half):x1 - (cx - half)] = rgba[y0:y1, x0:x1]
    im = Image.fromarray((canvas * 255).round().astype(np.uint8), "RGBA")
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    im.save(dst, quality=88, alpha_quality=80, method=6)
    print(dst, im.size)


def flatten(src: str, dst: str) -> None:
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64) / 255
    paper = np.median(
        np.concatenate([a[:64, :64].reshape(-1, 3), a[:64, -64:].reshape(-1, 3),
                        a[:200, :200].reshape(-1, 3)]), axis=0)
    dark = np.clip((paper - a) / paper, 0, 1).max(axis=2)
    # 纸纹多在 2% 以内：2%→7% 之间平滑过渡，7% 以上（墨、雾）原样保留
    w = smoothstep(np.clip((dark - 0.02) / 0.05, 0, 1))[..., None]
    out = paper * (1 - w) + a * w
    Image.fromarray((out * 255).round().astype(np.uint8)).save(dst, quality=80, method=6)
    print(dst, "paper", (paper * 255).round())


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5) or sys.argv[1] not in ("alpha", "flatten"):
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "alpha":
        to_alpha(sys.argv[2], sys.argv[3], floor=float(sys.argv[4]) if len(sys.argv) == 5 else 0.045)
    else:
        flatten(sys.argv[2], sys.argv[3])
