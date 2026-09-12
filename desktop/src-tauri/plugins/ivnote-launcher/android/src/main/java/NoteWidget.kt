package com.ivyea.note.launcher

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 「笔记卡片」小部件：桌面上预览一篇笔记，点一下直接打开它编辑。
 *
 * 显示什么，按这个顺序决定：
 * 1. 这张卡片绑了某篇（App 里「添加到桌面」、或添加后十分钟内的手动添加）→ 那篇的快照；
 * 2. 没绑 → 最近打开的一篇（JS 每次打开 / 保存都会推，对标系统笔记的「最近小记」）；
 * 3. 连最近的也没有（装完还没打开过 App）→ 一句引导，点了打开 App。
 *
 * 全部数据来自 [WidgetStore]，所以 App 进程没起来时系统要求重画也画得出来。
 * 尺寸自适应只做一件事：按卡片高度算正文行数——RemoteViews 能用的控件有限，
 * 一套布局 + 行数比三套布局更稳。
 */
class NoteWidget : AppWidgetProvider() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_PIN_DONE) {
      // 「添加到桌面」成功：系统把新卡片的 id 放在 extras 里，绑到进行中的那篇
      val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      val store = WidgetStore(context)
      val pending = store.takePendingPin()
      if (id != AppWidgetManager.INVALID_APPWIDGET_ID && pending != null) {
        store.bind(id, pending)
        render(context, AppWidgetManager.getInstance(context), id)
      }
      return
    }
    super.onReceive(context, intent)
  }

  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val store = WidgetStore(context)
    for (id in ids) {
      // 手动添加的新卡片：十分钟内 App 里点过「添加到桌面」就绑到那篇（启动器不支持一键添加时的补偿路）
      if (store.binding(id) == null) {
        store.peekPendingPin()?.let { store.bind(id, it) }
      }
      render(context, manager, id)
    }
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    render(context, manager, id)
  }

  override fun onDeleted(context: Context, ids: IntArray) {
    val store = WidgetStore(context)
    store.unbind(ids)
    store.pruneSnapshots()
  }

  companion object {
    /** 「添加到桌面」成功回调的 action（显式投给本 receiver，不对外） */
    const val ACTION_PIN_DONE = "com.ivyea.note.launcher.PIN_DONE"

    private val TIME_FMT = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    /** 重画所有笔记卡片（JS 推来新快照 / 绑定变化时调） */
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, NoteWidget::class.java))
      for (id in ids) render(context, manager, id)
    }

    /** 只重画显示某篇的卡片（绑定到它的 + 没绑定且它正是最近一篇的） */
    fun updateShowing(context: Context, b: WidgetStore.Binding) {
      val store = WidgetStore(context)
      val manager = AppWidgetManager.getInstance(context)
      val recent = store.recent()
      val recentIsIt = recent != null && recent.vaultId == b.vaultId && recent.path == b.path
      for (id in manager.getAppWidgetIds(ComponentName(context, NoteWidget::class.java))) {
        val bound = store.binding(id)
        if (bound == b || (bound == null && recentIsIt)) render(context, manager, id)
      }
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int) {
      val store = WidgetStore(context)
      val bound = store.binding(id)
      val snap = if (bound != null) store.snapshot(bound) else store.recent()
      val views = build(context, bound, snap, manager.getAppWidgetOptions(id), id)
      manager.updateAppWidget(id, views)
    }

    /**
     * 造 RemoteViews。`options` 可为 null（「添加到桌面」确认框里的预览）。
     * 拆出来是为了预览和真实卡片走同一份画法。
     */
    fun build(
      context: Context,
      bound: WidgetStore.Binding?,
      snap: WidgetStore.Snapshot?,
      options: Bundle?,
      requestCode: Int,
    ): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.ivw_note)
      val res = context.resources
      when {
        snap != null -> {
          views.setTextViewText(R.id.ivw_title, snap.title.ifEmpty { res.getString(R.string.ivw_untitled) })
          views.setTextViewText(
            R.id.ivw_body,
            snap.preview.ifEmpty { res.getString(R.string.ivw_empty_note) }
          )
          views.setTextViewText(R.id.ivw_time, if (snap.mtime > 0) TIME_FMT.format(Date(snap.mtime)) else "")
          views.setViewVisibility(R.id.ivw_time, if (snap.mtime > 0) View.VISIBLE else View.GONE)
          views.setOnClickPendingIntent(
            R.id.ivw_root,
            activity(context, requestCode, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_NOTE, snap.vaultId, snap.path))
          )
        }
        bound != null -> {
          // 绑了、但快照还没来（或那篇已经不在了）：把标题从路径里抠出来，点了仍然去打开——
          // JS 那边会核实存在与否并给出准确的提示
          views.setTextViewText(R.id.ivw_title, titleOf(bound.path))
          views.setTextViewText(R.id.ivw_body, res.getString(R.string.ivw_no_snapshot))
          views.setViewVisibility(R.id.ivw_time, View.GONE)
          views.setOnClickPendingIntent(
            R.id.ivw_root,
            activity(context, requestCode, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_NOTE, bound.vaultId, bound.path))
          )
        }
        else -> {
          views.setTextViewText(R.id.ivw_title, res.getString(R.string.ivw_app_name))
          views.setTextViewText(R.id.ivw_body, res.getString(R.string.ivw_hint_open_first))
          views.setViewVisibility(R.id.ivw_time, View.GONE)
          views.setOnClickPendingIntent(
            R.id.ivw_root,
            activity(context, requestCode, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_APP))
          )
        }
      }
      views.setInt(R.id.ivw_body, "setMaxLines", bodyLines(context, options))
      return views
    }

    /**
     * 正文能放几行：卡片高度(dp) 去掉头部、时间行和内边距，再除以行高。
     * `OPTION_APPWIDGET_MIN_HEIGHT` 是竖屏下的高度（横屏更矮，宁可少显示也不截半行）。
     */
    private fun bodyLines(context: Context, options: Bundle?): Int {
      val minH = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
      if (minH <= 0) return 4
      val res = context.resources
      fun dp(id: Int) = res.getDimension(id) / res.displayMetrics.density
      // 文字尺寸是 sp：用户把系统字体调大，行高和标题行都跟着长，dp 算出来的行数要按 fontScale 缩
      val scale = res.configuration.fontScale.coerceAtLeast(1f)
      val fixed = dp(R.dimen.ivw_pad) * 2 + dp(R.dimen.ivw_header_h) * scale + dp(R.dimen.ivw_time_h) * scale
      val line = dp(R.dimen.ivw_line_h) * scale
      return ((minH - fixed) / line).toInt().coerceIn(1, 40)
    }

    private fun titleOf(path: String): String {
      val base = path.substringAfterLast('/')
      return base.replace(Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE), "")
    }

    /** 点击用的 PendingIntent：内容固定、系统不需要往里填东西 → IMMUTABLE */
    fun activity(context: Context, requestCode: Int, intent: Intent): PendingIntent {
      var flags = PendingIntent.FLAG_UPDATE_CURRENT
      if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getActivity(context, requestCode, intent, flags)
    }
  }
}
