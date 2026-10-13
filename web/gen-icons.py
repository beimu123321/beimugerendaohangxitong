# -*- coding: utf-8 -*-
"""生成 Aurora Console 单色图标三件套：favicon.svg / apple-touch-icon.png / favicon.ico
设计对齐站点头部 logo：圆角方块 + 「北」字，浅色模式深底白字，深色模式浅底深字。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.dirname(os.path.abspath(__file__))
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

# 站点 logo 实际配色（aurora-console/index.html）
LIGHT_TILE, LIGHT_GLYPH = "#1d1d1f", "#f5f5f7"   # 浅色主题：--text / --bg
DARK_TILE, DARK_GLYPH = "#f5f5f7", "#08080a"     # 深色主题：--text / --bg

# ---------- 1. favicon.svg（主题自适应） ----------
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <style>
    .tile{{fill:{LIGHT_TILE}}}
    .glyph{{fill:{LIGHT_GLYPH}}}
    @media (prefers-color-scheme:dark){{
      .tile{{fill:{DARK_TILE}}}
      .glyph{{fill:{DARK_GLYPH}}}
    }}
  </style>
  <rect class="tile" width="64" height="64" rx="20"/>
  <text class="glyph" x="32" y="32" text-anchor="middle" dominant-baseline="central"
    font-family="'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif"
    font-size="34" font-weight="800">&#x5317;</text>
</svg>
'''
with open(os.path.join(OUT, "favicon.svg"), "w", encoding="utf-8") as f:
    f.write(svg)

# ---------- 2. PNG / ICO 渲染 ----------
def render_tile(size, tile, glyph, radius_ratio, glyph_ratio, font_path=FONT_BOLD):
    """渲染圆角方块 + 居中「北」字"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=tile)
    fs = int(size * glyph_ratio)
    font = ImageFont.truetype(font_path, fs)
    # 用字体度量做垂直居中（dominant-baseline 等价）
    asc, desc = font.getmetrics()
    bbox = d.textbbox((0, 0), "北", font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] - (asc + desc - fs) / 2 + (asc - (asc + desc)) / 2
    # 简化：按 em 盒中心居中
    y = (size - (asc + desc)) / 2 - bbox[1] + (asc + desc - fs) / 2
    d.text((x, y), "北", font=font, fill=glyph)
    return img

# apple-touch-icon：180x180 全幅（iOS 自行圆角遮罩）
ati = render_tile(180, LIGHT_TILE, LIGHT_GLYPH, 0.0, 0.46)
ati.save(os.path.join(OUT, "apple-touch-icon.png"))

# PWA 图标：192 圆角方块；512 满幅 + 缩小字形（maskable 安全区：中心 80% 直径圆内）
pwa192 = render_tile(192, LIGHT_TILE, LIGHT_GLYPH, 0.31, 0.44)
pwa192.save(os.path.join(OUT, "pwa-192.png"))
pwa512 = render_tile(512, LIGHT_TILE, LIGHT_GLYPH, 0.0, 0.30)
pwa512.save(os.path.join(OUT, "pwa-512.png"))

# favicon.ico：48 渲染后降采样到 32/16，多分辨率合成
big = render_tile(48, LIGHT_TILE, LIGHT_GLYPH, 0.31, 0.46)
frames = [big.resize((s, s), Image.LANCZOS) for s in (48, 32, 16)]
frames[0].save(
    os.path.join(OUT, "favicon.ico"),
    format="ICO",
    sizes=[(16, 16), (32, 32), (48, 48)],
    append_images=frames[1:],
)

# 预览图：64px 放大 4 倍便于肉眼检查
prev = render_tile(64, LIGHT_TILE, LIGHT_GLYPH, 0.31, 0.46).resize((256, 256), Image.NEAREST)
prev.save(os.path.join(OUT, "icon-preview-light.png"))
prevd = render_tile(64, DARK_TILE, DARK_GLYPH, 0.31, 0.46).resize((256, 256), Image.NEAREST)
prevd.save(os.path.join(OUT, "icon-preview-dark.png"))

print("favicon.svg", len(svg), "B")
for n in ("apple-touch-icon.png", "pwa-192.png", "pwa-512.png", "favicon.ico", "icon-preview-light.png", "icon-preview-dark.png"):
    p = os.path.join(OUT, n)
    print(n, os.path.getsize(p), "B")
