"""品牌图标生成：唯一源是 ivyea-note-logo.png，其余全部由它派生。

用法（在 desktop/ 下）：
    python3 brand/gen.py            # 三张 1024 源位图
    python3 brand/gen.py --android  # 安卓自适应前景层（各密度）
    python3 brand/gen.py --web      # favicon / apple-touch / 应用内 logo
"""
import sys
from PIL import Image

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
    icon.save('brand/ivyea-note-icon-1024.png')
    print('三张 1024 源位图已生成')


if __name__ == '__main__':
    main()
