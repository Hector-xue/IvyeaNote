# 品牌资产

本目录是 Ivyea Note 全部图标的**唯一源**。改图标只改这里，然后按下面的流程重新生成。

## 文件

| 文件 | 用途 |
|---|---|
| `ivyea-mark.svg` | 纯品牌标记，透明底。应用内 logo（`src/assets/logo.svg` 是它的副本）、关于页、加载页 |
| `ivyea-note-icon.svg` | 应用图标：纸白底 + 标记占 64%。桌面 / iOS / favicon 的源 |
| `ivyea-note-adaptive-foreground.svg` | 安卓自适应图标的**前景层**：只有标记，占 108dp 画布的 44%（= 可见区 72dp 的 66%） |
| `*-1024.png` | 上面三个的 1024px 位图，供 `tauri icon` 等工具消费 |

## 三条不能破的规矩

1. **标记必须是真矢量。** 历史上 `src/assets/logo.svg` 是 `<svg><image href="data:image/png;base64,…">`——PNG 套了个 SVG 壳，51KB 且放大就糊。现在的路径数据由官网原图描摹而来，3.5KB，任意缩放清晰。**不要再往里塞位图。**
2. **子品牌靠底色区分，不靠往标记上加东西。** 旧图标把「藤蔓 y + 大叶 + 小叶 + 文稿 + 笔」五个物件堆进一张图，60px（手机主屏真实尺寸）下糊成一团绿。图标只允许有一个主体。
3. **应用图标不能透明。** iOS 要求不透明底；安卓自适应图标的背景由 `values/ic_launcher_background.xml` 单独铺。只有 `ivyea-mark.svg` 和安卓前景层是透明的。

## 重新生成全平台图标

```bash
cd desktop

# 1) SVG → 1024 位图（需要 python3 + cairosvg）
python3 - <<'PY'
import cairosvg
for n in ['ivyea-mark','ivyea-note-icon','ivyea-note-adaptive-foreground']:
    cairosvg.svg2png(url=f'brand/{n}.svg', write_to=f'brand/{n}-1024.png',
                     output_width=1024, output_height=1024)
PY

# 2) 生成桌面 / iOS / Windows 全套
npx tauri icon brand/ivyea-note-icon-1024.png

# 3) ⚠️ tauri icon 把安卓图标写进 gen/android/（CI 会重新生成、不入库），
#    而 APK 实际用的是 src-tauri/icons/android/（release.yml 在 android init 之后
#    用 `cp -r src-tauri/icons/android/. gen/android/app/src/main/res/` 覆盖回去）。
#    所以必须手动同步，否则「本地看着换了、下载的包还是旧 logo」。
GEN=src-tauri/gen/android/app/src/main/res
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp "$GEN/mipmap-$d/ic_launcher.png"       "src-tauri/icons/android/mipmap-$d/"
  cp "$GEN/mipmap-$d/ic_launcher_round.png" "src-tauri/icons/android/mipmap-$d/"
done
cp -r "$GEN/mipmap-anydpi-v26/." src-tauri/icons/android/mipmap-anydpi-v26/

# 4) 安卓自适应前景层要用专门的源（tauri 生成的那份是整张图，
#    系统裁掉外圈后叶尖会被切）
python3 - <<'PY'
import cairosvg
for d, px in {'mdpi':108,'hdpi':162,'xhdpi':216,'xxhdpi':324,'xxxhdpi':432}.items():
    cairosvg.svg2png(url='brand/ivyea-note-adaptive-foreground.svg',
                     write_to=f'src-tauri/icons/android/mipmap-{d}/ic_launcher_foreground.png',
                     output_width=px, output_height=px)
PY

# 5) Web favicon
python3 - <<'PY'
import cairosvg
cairosvg.svg2png(url='brand/ivyea-note-icon.svg', write_to='public/favicon.png',
                 output_width=256, output_height=256)
cairosvg.svg2png(url='brand/ivyea-note-icon.svg', write_to='public/apple-touch-icon.png',
                 output_width=180, output_height=180)
PY
cp brand/ivyea-mark.svg       src/assets/logo.svg
cp brand/ivyea-note-icon.svg  public/favicon.svg
```

## 色值

| 用途 | 值 |
|---|---|
| 标记渐变（浅→深） | `#8FAE79` → `#35603C` |
| 纸白底渐变 | `#FFFFFF` → `#F1EFE6` |
| 安卓自适应背景（纯色） | `#F7F5EF` |
| 深色底上的标记渐变 | `#DCEBC9` → `#7FB56E` |
