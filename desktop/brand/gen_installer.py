#!/usr/bin/env python3
"""
生成 Windows 安装向导用的两张位图（v0.11.23）。

# 为什么必须是脚本，而不是"用图形软件画一次"

这两张图的尺寸是 **NSIS MUI2 写死的**，不是审美选择：
- 顶部横幅 `MUI_HEADERIMAGE_BITMAP`：**150 × 57**
- 欢迎/完成页左侧竖图 `MUI_WELCOMEFINISHPAGE_BITMAP`：**164 × 314**

而且 Tauri 的模板**没有开 `MUI_HEADERIMAGE_NOSTRETCH`**（见
tauri-bundler 的 installer.nsi），尺寸不对不会报错，会被**拉伸变形**——
这种"不报错但很难看"的失败最容易混过发版。所以尺寸写在代码里，改不坏。

# 两个刻意的选择

- **顶部横幅只放叶子，不放字。** MUI2 的标题文字和这张图在同一条横栏里，
  谁左谁右由主题决定；图里再放一次品牌名，两边都可能撞在一起。
- **全部浅色。** 与 v0.11.22 之后的品牌一致，也因为安装向导本身是浅色的，
  深色块插进去像贴了张膏药。

用法：python3 brand/gen_installer.py   （输出到 src-tauri/installer/）
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "src-tauri", "installer"))
MARK = os.path.join(HERE, "ivyea-note-logo.png")  # 去背的叶子标

HEADER_SIZE = (150, 57)
SIDEBAR_SIZE = (164, 314)

CJK = "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Medium.ttc"
CJK_LIGHT = "/usr/share/fonts/google-noto-cjk/NotoSansCJK-DemiLight.ttc"


def _font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size, index=2)  # index 2 = SC，实测能出中文字形


def _paste_mark(canvas: Image.Image, box_h: int, center: tuple[int, int]) -> None:
    """把叶子标等比缩到指定高度贴上去（保留 alpha，贴在浅底上）。"""
    mark = Image.open(MARK).convert("RGBA")
    # 去掉四周透明留白，否则视觉重心偏、看着像没对齐
    mark = mark.crop(mark.getbbox())
    w = round(mark.width * box_h / mark.height)
    mark = mark.resize((w, box_h), Image.LANCZOS)
    canvas.paste(mark, (center[0] - w // 2, center[1] - box_h // 2), mark)


def make_header() -> Image.Image:
    """顶部横幅：白底 + 居中偏右的叶子。白底是为了和 MUI 的白色标题栏无缝。"""
    im = Image.new("RGB", HEADER_SIZE, "#FFFFFF")
    _paste_mark(im, 38, (HEADER_SIZE[0] // 2, HEADER_SIZE[1] // 2))
    return im


def make_sidebar() -> Image.Image:
    """欢迎页竖图：极浅的绿色渐变 + 叶子 + 品牌名 + 一行说明。"""
    w, h = SIDEBAR_SIZE
    im = Image.new("RGB", (w, h), "#FFFFFF")
    d = ImageDraw.Draw(im)
    # 自上而下：近白 → 淡绿。逐行画，避免出现色带
    top, bottom = (250, 253, 251), (218, 238, 226)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))

    _paste_mark(im, 96, (w // 2, 112))

    name = _font(CJK, 21)
    tag = _font(CJK_LIGHT, 12)
    title = "Ivyea Note"
    tw = d.textlength(title, font=name)
    d.text(((w - tw) / 2, 196), title, font=name, fill="#0c3a22")
    for i, line in enumerate(("本地优先的笔记", "多端同步 · 知识库")):
        lw = d.textlength(line, font=tag)
        d.text(((w - lw) / 2, 228 + i * 19), line, font=tag, fill="#4d6b5b")

    # 底部一道细线，给这块面板一个收口
    d.line([(28, h - 34), (w - 28, h - 34)], fill="#bcd8c8")
    ver = _font(CJK_LIGHT, 10)
    note = "ivyea.com"
    d.text(((w - d.textlength(note, font=ver)) / 2, h - 26), note, font=ver, fill="#6b8779")
    return im


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for name, im, size in (
        ("header.bmp", make_header(), HEADER_SIZE),
        ("sidebar.bmp", make_sidebar(), SIDEBAR_SIZE),
    ):
        assert im.size == size, f"{name} 尺寸必须是 {size}，NSIS 会拉伸不合规的图"
        path = os.path.join(OUT, name)
        # BMP3 = 24 位无 alpha：NSIS 的经典位图控件不认带 alpha 的 BMP
        im.save(path, format="BMP")
        print(f"生成 {path}  {im.size[0]}x{im.size[1]}")
        # 顺手出一张 PNG 预览，方便肉眼复核（不入库）
        im.resize((im.width * 2, im.height * 2), Image.NEAREST).save(
            os.path.join("/tmp", name.replace(".bmp", "-preview.png"))
        )


if __name__ == "__main__":
    main()
