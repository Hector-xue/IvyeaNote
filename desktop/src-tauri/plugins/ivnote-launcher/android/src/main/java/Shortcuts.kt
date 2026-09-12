package com.ivyea.note.launcher

import android.content.Context
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

/**
 * 长按图标菜单里的快捷方式，全部是**动态**的（运行时发布）。
 *
 * 不用 manifest 里的静态 shortcuts.xml，因为那份 manifest 不归我们管（见 lib.rs）。
 * 动态的代价只是"第一次启动之后才出现"——没启动过也就没有笔记库，本来也没什么可快捷的。
 * 由 JS 决定列表（新建 / 今日日记 / 最近两篇），这里只负责翻译成系统对象。
 */
object Shortcuts {
  data class Spec(val kind: String, val label: String, val vaultId: Long, val path: String)

  fun publish(context: Context, specs: List<Spec>) {
    val max = try {
      ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
    } catch (ex: Exception) {
      4
    }
    val list = ArrayList<ShortcutInfoCompat>()
    for ((rank, s) in specs.withIndex()) {
      if (list.size >= max) break
      val info = toInfo(context, s, rank) ?: continue
      list.add(info)
    }
    try {
      ShortcutManagerCompat.setDynamicShortcuts(context, list)
    } catch (ex: Exception) {
      // 个别启动器 / ROM 的 ShortcutManager 会抛 IllegalStateException（限速、锁屏中）。
      // 快捷方式是锦上添花，不能让这条把 JS 那边的调用打成失败
    }
  }

  private fun toInfo(context: Context, s: Spec, rank: Int): ShortcutInfoCompat? {
    val (action, icon, id) = when (s.kind) {
      LaunchIntents.KIND_NEW -> Triple(LaunchIntents.ACTION_NEW_NOTE, R.drawable.ivw_sc_new, "new")
      LaunchIntents.KIND_DAILY -> Triple(LaunchIntents.ACTION_DAILY, R.drawable.ivw_sc_daily, "daily")
      LaunchIntents.KIND_OPEN -> {
        if (s.path.isEmpty()) return null
        // id 只要求稳定且唯一；路径可能很长、含各种字符，用 hash 更稳妥
        Triple(LaunchIntents.ACTION_OPEN_NOTE, R.drawable.ivw_sc_note, "open:${s.vaultId}:${s.path.hashCode()}")
      }
      else -> return null
    }
    val label = s.label.ifBlank { context.getString(R.string.ivw_untitled) }
    return ShortcutInfoCompat.Builder(context, id)
      // 短标签最多 10 个字符会被启动器截断，长标签留全名给放大显示的地方
      .setShortLabel(label.take(10))
      .setLongLabel(label.take(25))
      .setIcon(IconCompat.createWithResource(context, icon))
      .setIntent(LaunchIntents.launch(context, action, s.vaultId, s.path))
      .setRank(rank)
      .build()
  }
}
