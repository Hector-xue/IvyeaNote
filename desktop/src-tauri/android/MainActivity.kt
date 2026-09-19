package com.ivyea.note

import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 覆盖 `cargo tauri android init` 生成的 MainActivity（CI 在 init 之后整文件拷过去；
 * gen/android 不入库，所以这份源码放在 src-tauri/android/ 里）。
 *
 * 与模板的唯一差别：**软键盘弹起时把 WebView 顶上去**（v0.11.37）。
 *
 * Tauri 的模板调 enableEdgeToEdge()，窗口不再随键盘缩放；WebView 自己（M139+）只会缩小
 * "视觉视口"、不动布局视口——于是 position:fixed 的底部栏、光标所在行统统留在键盘下面：
 * 用户长按想粘贴，光标把手画在键盘底下、系统的「粘贴」条被顶到屏幕最上沿。
 * 这里把 IME 的高度作为内边距加在内容视图上，WebView 实际变矮，布局视口跟着变，
 * 网页里的 fixed 底部栏、光标行、系统复制条就都回到键盘上方——和 Obsidian 一样。
 *
 * 只处理 IME，不动状态栏 / 导航栏 / 刘海：那些由网页的 env(safe-area-inset-*) 负责，
 * 这里若再加一遍就是双份内边距。返回时把 IME 那份置零（不是 CONSUMED）：
 * 按 Android 文档，置零能让下层照常收到更新、避免键盘收起后残留内边距。
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 明确要"缩放"而不是"平移"：adjustUnspecified 由系统猜，猜成 pan 就收不到 IME 内边距。
    // 该常量 API 30 起标记弃用，但在 edge-to-edge 下它只决定 IME 内边距派不派发，仍然有效。
    @Suppress("DEPRECATION")
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(0, 0, 0, ime.bottom)
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }
  }
}
