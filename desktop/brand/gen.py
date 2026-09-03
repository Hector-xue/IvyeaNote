"""品牌图标生成：唯一源是 ivyea-note-logo.png，其余全部由它派生。

用法（在 desktop/ 下）：
    python3 brand/gen.py            # 三张 1024 源位图
    python3 brand/gen.py --android  # 安卓自适应前景层（各密度）
    python3 brand/gen.py --ios      # iOS 改回方角不透明（系统自己加圆角）
    python3 brand/gen.py --web      # favicon / apple-touch / 应用内 logo
"""
import sys
from PIL import Image, ImageChops, ImageDraw

SRC = 'brand/ivyea-note-logo.png'


def trimmed_square(img, canvas=1024, fill_ratio=1.0, bg=None):
    """裁到内容包围盒 → 居中放进正方形画布，标记占 fill_ratio。

    先裁再缩是必须的：源图四边留白不均（左 97 上 9 右 32 下 74），
    直接缩放会让图标明显偏心。
    """
    mark = img.crop(img.getbbox())
    w, h = mark.size
    scale = int(canvas * fill_ratio) / max(w, h)
    mark = mark.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    out = Image.new('RGBA', (canvas, canvas), bg or (0, 0, 0, 0))
    out.alpha_composite(mark, ((canvas - mark.width) // 2, (canvas - mark.height) // 2))
    return out


def paper_gradient(size=1024):
    """纸白底 #FFFFFF → #F1EFE6。应用图标不能透明（iOS 要求；安卓另铺背景层）。"""
    g = Image.new('RGBA', (size, size))
    for y in range(size):
        t = y / (size - 1)
        g.paste(Image.new('RGBA', (size, 1),
                          (round(255 - 14 * t), round(255 - 16 * t), round(255 - 25 * t), 255)),
                (0, y))
    return g


# 圆角半径占边长的比例。0.2237 是 iOS/macOS 那条超椭圆的通行近似值，
# Windows 任务栏和 Linux dock 上看着也正好——再小就"不像圆角"，再大就发胖。
CORNER_RATIO = 0.2237


def rounded(img, ratio=CORNER_RATIO, ss=4):
    """把方角图标切成圆角矩形。

    用户原话：「桌面图标和状态栏图标也丑，换成 R 角的吧」——此前是一块**硬方角**
    的纸白瓷砖，在 Windows 任务栏和桌面上跟旁边一水儿的圆角图标格格不入。

    `ss` 是超采样倍率：直接在 1024 上画圆角，斜边会有明显锯齿；放大 4 倍画完
    再缩回来，边缘才干净。切的是 alpha，底色渐变原样保留。
    """
    size = img.size[0]
    big = size * ss
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=round(big * ratio), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = img.copy()
    # 与原有 alpha 取交集：底图本来透明的地方不能被圆角遮罩"补"成不透明
    out.putalpha(ImageChops.multiply(out.getchannel('A'), mask))
    return out


def main() -> None:
    im = Image.open(SRC).convert('RGBA')
    arg = sys.argv[1] if len(sys.argv) > 1 else ''

    if arg == '--android':
        fg = Image.open('brand/ivyea-note-adaptive-foreground-1024.png')
        for d, px in {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}.items():
            fg.resize((px, px), Image.LANCZOS).save(
                f'src-tauri/icons/android/mipmap-{d}/ic_launcher_foreground.png')
        print('安卓自适应前景层已生成')
        return

    if arg == '--ios':
        """iOS 那套**必须是方角不透明的**。

        系统会自己给应用图标加圆角遮罩，图里再带一层透明圆角就成了"圆角套圆角"，
        而且 App Store 明确不收带 alpha 的图标（提审即拒，桌面上表现是四角发黑）。
        所以 `tauri icon` 跑完之后，用方角版把 ios/ 整个覆盖回去。
        """
        import glob
        square = paper_gradient()
        square.alpha_composite(trimmed_square(im, 1024, 0.64))
        square = square.convert('RGB')
        for f in glob.glob('src-tauri/icons/ios/*.png'):
            n = Image.open(f).size[0]
            square.resize((n, n), Image.LANCZOS).save(f)
        print('iOS 图标已改回方角不透明')
        return

    if arg == '--web':
        icon = Image.open('brand/ivyea-note-icon-1024.png')
        icon.resize((256, 256), Image.LANCZOS).save('public/favicon.png')
        icon.resize((180, 180), Image.LANCZOS).save('public/apple-touch-icon.png')
        Image.open('brand/ivyea-mark-1024.png').resize((512, 512), Image.LANCZOS).save(
            'src/assets/logo.png')
        print('favicon / apple-touch / 应用内 logo 已生成')
        return

    trimmed_square(im, 1024, 0.96).save('brand/ivyea-mark-1024.png')
    trimmed_square(im, 1024, 0.44).save('brand/ivyea-note-adaptive-foreground-1024.png')
    icon = paper_gradient()
    icon.alpha_composite(trimmed_square(im, 1024, 0.64))
    # v0.10.7：圆角。安卓前景层不切——那边的形状由系统遮罩决定，
    # 自己先切一刀只会被再裁一次，叶尖就没了
    icon = rounded(icon)
    icon.save('brand/ivyea-note-icon-1024.png')
    print('三张 1024 源位图已生成')


if __name__ == '__main__':
    main()
