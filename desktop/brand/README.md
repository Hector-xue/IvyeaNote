# 品牌资产

本目录是 Ivyea Note 全部图标的**唯一源**。改图标只改这里，然后按下面的流程重新生成。

## 文件

| 文件 | 用途 |
|---|---|
| `ivyea-note-logo.png` | **唯一源图**（官方彩色渐变标记，1254px 透明底）。下面三张都由它生成 |
| `ivyea-mark-1024.png` | 纯标记、透明底、占画布 96%。应用内 logo（`src/assets/logo.png` 由它缩放而来） |
| `ivyea-note-icon-1024.png` | 应用图标：纸白底渐变 + 标记占 64%、**圆角**（R = 边长 × 0.2237）。桌面 / iOS / favicon 的源 |
| `ivyea-note-adaptive-foreground-1024.png` | 安卓自适应图标的**前景层**：只有标记，占 108dp 画布的 44%（= 可见区 72dp 的 66%） |

> ⚠️ 源图四边留白不均（左 97 上 9 右 32 下 74）。生成时**必须先裁到内容包围盒再居中**，
> 直接缩放原图会让图标明显偏心。

## 三条不能破的规矩

1. **位图就老老实实用位图，不要套 SVG 壳。** 历史上 `src/assets/logo.svg` 是
   `<svg><image href="data:image/png;base64,…">`——PNG 套了个 SVG 壳，51KB 且放大就糊。
   v0.10.1 换成官方彩色渐变标记后**源就是位图**（`ivyea-note-logo.png`，1254px）：
   这个标记有多层渐变，硬描成矢量只会更糊。所以应用内 logo 是 `src/assets/logo.png`
   （512px；最大显示 64px，够 4× DPR），**不再有 logo.svg / favicon.svg**。
   要点没变：**不要再造「里面塞着 base64 位图的 SVG」**。
2. **子品牌靠底色区分，不靠往标记上加东西。** 旧图标把「藤蔓 y + 大叶 + 小叶 + 文稿 + 笔」五个物件堆进一张图，60px（手机主屏真实尺寸）下糊成一团绿。图标只允许有一个主体。
3. **圆角只切桌面那一路，安卓和 iOS 不切。**（v0.10.7，用户：「桌面图标和状态栏图标也丑，换成 R 角的吧」）
   此前是一块硬方角的纸白瓷砖，在 Windows 任务栏和桌面上跟旁边一水儿的圆角图标格格不入。
   半径取边长的 **0.2237**（iOS/macOS 那条超椭圆的通行近似值），画的时候要**超采样 4 倍再缩**，
   否则斜边一圈锯齿。但：
   - **安卓不切**——形状由系统遮罩决定，自己先切一刀只会被再裁一次，叶尖就没了；
   - **iOS 不切**——系统自己加圆角，图里再带透明圆角就是"圆角套圆角"，
     而且 App Store 不收带 alpha 的图标（提审即拒，桌面上表现是四角发黑）。
     所以 `tauri icon` 跑完之后必须用 `--ios` 把 ios/ 覆盖回方角不透明版。
4. **应用图标不能透明。** iOS 要求不透明底；安卓自适应图标的背景由 `values/ic_launcher_background.xml` 单独铺。只有 `ivyea-mark.svg` 和安卓前景层是透明的。

## 重新生成全平台图标

前提：`python3` + `Pillow`（本机已有）。**改图标只改 `ivyea-note-logo.png`，然后从头跑一遍。**

```bash
cd desktop
python3 brand/gen.py            # 1) 源图 → 三张 1024 位图
npx tauri icon brand/ivyea-note-icon-1024.png   # 2) 桌面 / iOS / Windows 全套
```

3) ⚠️ **安卓那套必须手动同步**。`tauri icon` 把安卓图标写进 `gen/android/`（CI 会重新生成、不入库），
而 APK 实际用的是 `src-tauri/icons/android/`（`release.yml` 在 `android init` 之后用
`cp -r src-tauri/icons/android/. gen/.../res/` 覆盖回去）。不同步就是
**「本地看着换了、下载的包还是旧 logo」**：

```bash
GEN=src-tauri/gen/android/app/src/main/res
for d in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  cp -f "$GEN/mipmap-$d/ic_launcher.png"       "src-tauri/icons/android/mipmap-$d/"
  cp -f "$GEN/mipmap-$d/ic_launcher_round.png" "src-tauri/icons/android/mipmap-$d/"
done
cp -rf "$GEN/mipmap-anydpi-v26/." src-tauri/icons/android/mipmap-anydpi-v26/
python3 brand/gen.py --android  # 4) 自适应前景层按各密度单独生成
python3 brand/gen.py --ios      # 5) iOS 改回方角不透明（见上面第 3 条）
python3 brand/gen.py --web      # 6) favicon / apple-touch / 应用内 logo
```

第 4 步不能省：`tauri icon` 生成的前景层是整张图，系统裁掉外圈后**叶尖会被切**。
第 5 步也不能省：`tauri icon` 会把带圆角 alpha 的源图直接铺到 iOS 那套上。

⚠️ 本机 `cp` 是 `-i`，**`-f` 压不住**（无 stdin 时静默跳过、退出码还是 0），
上面那段拷贝要用 `cat 源 > 目标`，别用 `cp -f`——不然就是"命令跑完了、文件没换"。


## 色值

| 用途 | 值 |
|---|---|
| 标记渐变（浅→深） | `#8FAE79` → `#35603C` |
| 纸白底渐变 | `#FFFFFF` → `#F1EFE6` |
| 安卓自适应背景（纯色） | `#F7F5EF` |
| 深色底上的标记渐变 | `#DCEBC9` → `#7FB56E` |
