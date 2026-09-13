#!/usr/bin/env python3
"""
画小部件选择器里的预览图（res/drawable-nodpi/ivw_preview_*.png）。

大多数国产桌面只认 android:previewImage，不认 previewLayout，所以每种小部件都要
一张按真实比例画好的图。这里用 PIL 照着 layout/ivw_*.xml 的结构画（3x 密度：1dp = 3px），
文字、颜色、圆角与真实卡片一致——改布局的同时改这里，再跑一遍：

    python3 tools/render-previews.py

依赖：Pillow + Noto Sans CJK（/usr/share/fonts/google-noto-cjk）。
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "android/src/main/res/drawable-nodpi"
FONT_DIR = Path("/usr/share/fonts/google-noto-cjk")
SC = 2  # ttc 里简体中文那一面
D = 3   # 1dp = 3px

BG = (253, 252, 249, 255)
TEXT = (29, 29, 31, 255)
BODY = (72, 72, 74, 255)
MUTED = (142, 142, 147, 255)
LINE = (0, 0, 0, 20)
ACCENT = (53, 96, 60, 255)
ACCENT_SOFT = (231, 240, 228, 255)
RING = (185, 185, 190, 255)
WHITE = (255, 255, 255, 255)


def font(weight: str, sp: float) -> ImageFont.FreeTypeFont:
    name = {"regular": "NotoSansCJK-Regular.ttc", "medium": "NotoSansCJK-Medium.ttc"}[weight]
    return ImageFont.truetype(str(FONT_DIR / name), int(round(sp * D)), index=SC)


def dp(v: float) -> int:
    return int(round(v * D))


def card(w_dp: int, h_dp: int):
    img = Image.new("RGBA", (dp(w_dp), dp(h_dp)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=dp(20), fill=BG)
    return img, d


def text(d, xy, s, f, fill, anchor="la"):
    d.text(xy, s, font=f, fill=fill, anchor=anchor)


def ellipsis(d, s, f, max_w):
    if d.textlength(s, font=f) <= max_w:
        return s
    while s and d.textlength(s + "…", font=f) > max_w:
        s = s[:-1]
    return s + "…"


def fab(d, cx, cy, r_dp, kind):
    r = dp(r_dp)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ACCENT)
    w = dp(1.9)
    if kind == "plus":
        a = dp(r_dp * 0.42)
        d.line((cx - a, cy, cx + a, cy), fill=WHITE, width=w)
        d.line((cx, cy - a, cx, cy + a), fill=WHITE, width=w)
    elif kind == "calendar":
        a = dp(r_dp * 0.40)
        d.rounded_rectangle((cx - a, cy - a + dp(1), cx + a, cy + a), radius=dp(1.5), outline=WHITE, width=w)
        d.line((cx - a, cy - a + dp(5), cx + a, cy - a + dp(5)), fill=WHITE, width=w)
    else:  # pencil：斜放的笔杆 + 笔尖
        a = dp(r_dp * 0.42)
        d.line((cx - a + dp(1.5), cy + a - dp(1.5), cx + a - dp(2), cy - a + dp(2)), fill=WHITE, width=dp(3.2))
        d.polygon([(cx - a, cy + a), (cx - a + dp(1), cy + a - dp(3.5)), (cx - a + dp(3.5), cy + a - dp(1))], fill=ACCENT)
    

def ring(d, cx, cy, r_dp):
    r = dp(r_dp)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=RING, width=dp(1.8))


def hairline(d, x1, x2, y):
    d.line((x1, y, x2, y), fill=LINE, width=max(1, dp(0.5)))


# ---------------------------------------------------------------- 笔记卡片 2×2

def note():
    W, H, P = 150, 150, 14
    img, d = card(W, H)
    x = dp(P)
    text(d, (x, dp(P + 12)), "每周复盘", font("medium", 16), TEXT, "lm")
    f = font("regular", 13)
    y = dp(P + 24 + 4)
    # 布局按高度算能放几行：150dp 的卡片放 3 行（NoteWidget.bodyLines 同一套算法）
    for line in ["• 新品样品周三到", "• 先拍主图再上架", "☐ 给供应商回邮件"]:
        if line.startswith("☐ "):
            # Noto Sans CJK 没有 ☐，手画一个（真机上系统符号字体有）
            s = dp(5)
            cy = y + dp(9.5)
            d.rectangle((x, cy - s, x + 2 * s, cy + s), outline=BODY, width=dp(1.2))
            text(d, (x + dp(15), y), ellipsis(d, line[2:], f, dp(W - 2 * P - 15)), f, BODY)
        else:
            text(d, (x, y), ellipsis(d, line, f, dp(W - 2 * P)), f, BODY)
        y += dp(20)
    fy = dp(H - P - 15)
    text(d, (x, fy), "昨天 21:40", font("regular", 11), MUTED, "lm")
    fab(d, dp(W - P - 15), fy, 15, "pencil")
    return img


# ---------------------------------------------------------------- 快捷创建 2×1

def quick():
    W, H = 150, 70
    img, d = card(W, H)
    cy = H // 2
    text(d, (dp(16), dp(cy - 8)), "新建笔记", font("medium", 14), TEXT, "lm")
    text(d, (dp(16), dp(cy + 9)), "随手记一条", font("regular", 11), MUTED, "lm")
    fab(d, dp(W - 12 - 19), dp(cy), 19, "calendar")
    return img


# ---------------------------------------------------------------- 快速记录 2×2

def quick_card():
    W, H, P = 150, 150, 14
    img, d = card(W, H)
    x = dp(P)
    text(d, (x, dp(P)), "9月13日 周六", font("regular", 12), MUTED)
    f = font("medium", 17)
    text(d, (x, dp(P + 16 + 6)), "零碎念头，", f, TEXT)
    text(d, (x, dp(P + 16 + 6 + 26)), "随手记下", f, TEXT)
    fy = dp(H - P - 15)
    # 日历小图标 + 「今日日记」
    cx, cy, s = x, fy, dp(7)
    d.rounded_rectangle((cx, cy - s + dp(1), cx + 2 * s, cy + s), radius=dp(1.5), outline=ACCENT, width=dp(1.6))
    d.line((cx, cy - s + dp(5), cx + 2 * s, cy - s + dp(5)), fill=ACCENT, width=dp(1.6))
    text(d, (x + dp(16 + 5), fy), "今日日记", font("medium", 12), ACCENT, "lm")
    fab(d, dp(W - P - 15), fy, 15, "plus")
    return img


# ---------------------------------------------------------------- 列表壳（最近 / 待办）

def list_shell(W, H, title, count=None):
    img, d = card(W, H)
    P = 12
    x1, x2 = dp(P), dp(W - P)
    hy = dp(8 + 15)
    fm = font("medium", 13)
    text(d, (x1, hy), title, fm, TEXT, "lm")
    if count is not None:
        tx = x1 + d.textlength(title, font=fm) + dp(6)
        fc = font("medium", 10)
        cw = d.textlength(count, font=fc) + dp(14)
        d.rounded_rectangle((tx, hy - dp(8), tx + cw, hy + dp(8)), radius=dp(8), fill=ACCENT_SOFT)
        text(d, (tx + cw / 2, hy), count, fc, ACCENT, "mm")
    fab(d, x2 - dp(13), hy, 13, "plus")
    return img, d, x1, x2, dp(8 + 30)


def recent():
    W, H = 320, 150
    img, d, x1, x2, y = list_shell(W, H, "最近笔记")
    rows = [("每周复盘", "昨天"), ("供应商清单", "周三"), ("读书笔记：卓有成效的管理者", "9月8日")]
    ft, fs = font("regular", 14), font("regular", 11)
    rh = dp(34)
    for i, (t, s) in enumerate(rows):
        cy = y + rh // 2
        d.ellipse((x1, cy - dp(3), x1 + dp(6), cy + dp(3)), fill=ACCENT)
        sw = d.textlength(s, font=fs)
        text(d, (x1 + dp(16), cy), ellipsis(d, t, ft, x2 - x1 - dp(16 + 10) - sw), ft, TEXT, "lm")
        text(d, (x2, cy), s, fs, MUTED, "rm")
        y += rh
        if i < len(rows) - 1:
            hairline(d, x1, x2, y)
    return img


def todo():
    W, H = 320, 150
    img, d, x1, x2, y = list_shell(W, H, "待办", "3")
    rows = [("给供应商回邮件", "每周复盘"), ("周五前把发票整理好", "每周复盘"), ("样品到了先拍主图", "新品")]
    ft, fs = font("regular", 14), font("regular", 11)
    rh = dp(34)
    for i, (t, s) in enumerate(rows):
        cy = y + rh // 2
        ring(d, x1 + dp(11), cy, 10.5)
        sw = d.textlength(s, font=fs)
        text(d, (x1 + dp(34), cy), ellipsis(d, t, ft, x2 - x1 - dp(34 + 10) - sw), ft, TEXT, "lm")
        text(d, (x2, cy), s, fs, MUTED, "rm")
        y += rh
        if i < len(rows) - 1:
            hairline(d, x1, x2, y)
    return img


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in [("note", note), ("quick", quick), ("quick_card", quick_card), ("recent", recent), ("todo", todo)]:
        p = OUT / f"ivw_preview_{name}.png"
        fn().save(p, optimize=True)
        print(p.name, Image.open(p).size)
