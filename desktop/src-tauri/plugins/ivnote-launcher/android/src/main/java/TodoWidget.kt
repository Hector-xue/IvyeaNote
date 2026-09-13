package com.ivyea.note.launcher

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat

/**
 * 「待办」小部件（4×2 起，可拉高）：当前库里所有笔记的未完成 `- [ ]`，一行一条，
 * 点圈勾掉、点文字打开那篇。列表由 JS 从全文索引里算出来推过来（[WidgetStore.putTodoSnapshot]）。
 *
 * ## 勾掉一条会发生什么（三条路，按可用性退）
 *
 * 1. 先把这条画成已完成（[WidgetStore.markDone]），手感上立刻响应；
 * 2. App 活着（[LauncherPlugin.notifyTodoToggle]）→ 发事件给 JS，由编辑器自己改那一行——
 *    和手动在笔记里勾选是同一段代码，正在编辑也不会打架；
 * 3. App 没起来、库在磁盘上（SAF / 绝对路径）→ 原生直接改文件（[TodoWriter]），核对不上就不动；
 * 4. 原生改不了（OPFS / 行对不上）→ 排进 [WidgetStore.queuePendingToggle]，App 下次起来领走处理。
 *
 * 文件 IO 不能在 receiver 的主线程上做（SAF 是跨进程调用），用 goAsync + 线程。
 */
class TodoWidget : AppWidgetProvider() {

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_TOGGLE) {
      val item = WidgetStore.TodoItem(
        intent.getStringExtra(EXTRA_PATH) ?: return,
        intent.getStringExtra(EXTRA_TITLE) ?: "",
        intent.getIntExtra(EXTRA_LINE, -1),
        intent.getStringExtra(EXTRA_RAW) ?: "",
        intent.getStringExtra(EXTRA_TEXT) ?: "",
      )
      val store = WidgetStore(context)
      store.markDone(item.key)
      updateAll(context)
      val pending = goAsync()
      Thread {
        try {
          toggle(context, store, item)
        } finally {
          pending.finish()
        }
      }.start()
      return
    }
    super.onReceive(context, intent)
  }

  private fun toggle(context: Context, store: WidgetStore, item: WidgetStore.TodoItem) {
    if (LauncherPlugin.notifyTodoToggle(store.todoVaultId(), item)) return
    when (TodoWriter.toggle(context, store.todoRoot(), item.path, item.line, item.raw)) {
      TodoWriter.Result.OK -> {
        store.removeTodoItem(item.key)
        updateAll(context)
      }
      else -> store.queuePendingToggle(item, store.todoVaultId())
    }
  }

  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) render(context, manager, id)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    render(context, manager, id)
  }

  companion object {
    const val ACTION_TOGGLE = "com.ivyea.note.launcher.TODO_TOGGLE"
    private const val EXTRA_PATH = "path"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_LINE = "line"
    private const val EXTRA_RAW = "raw"
    private const val EXTRA_TEXT = "text"

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for (id in manager.getAppWidgetIds(ComponentName(context, TodoWidget::class.java))) render(context, manager, id)
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int) {
      val store = WidgetStore(context)
      manager.updateAppWidget(id, build(context, store, store.todoItems(), manager.getAppWidgetOptions(id), id))
    }

    fun build(context: Context, store: WidgetStore, items: List<WidgetStore.TodoItem>, options: Bundle?, requestCode: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.ivw_list)
      val res = context.resources
      val vaultId = store.todoVaultId()
      views.setTextViewText(R.id.ivw_head, res.getString(R.string.ivw_todo_widget_label))
      val open = items.filter { !store.isDone(it.key) }
      if (open.isNotEmpty()) {
        views.setViewVisibility(R.id.ivw_count, View.VISIBLE)
        views.setTextViewText(R.id.ivw_count, open.size.toString())
      } else {
        views.setViewVisibility(R.id.ivw_count, View.GONE)
      }
      views.setOnClickPendingIntent(
        R.id.ivw_new,
        Widgets.activity(context, requestCode * 64, LaunchIntents.launch(context, LaunchIntents.ACTION_NEW_NOTE))
      )
      val openApp = Widgets.activity(context, requestCode * 64 + 1, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_APP))
      views.setOnClickPendingIntent(R.id.ivw_header, openApp)
      views.removeAllViews(R.id.ivw_rows)
      if (items.isEmpty()) {
        views.setViewVisibility(R.id.ivw_rows, View.GONE)
        views.setViewVisibility(R.id.ivw_empty, View.VISIBLE)
        views.setTextViewText(R.id.ivw_empty, res.getString(R.string.ivw_todo_empty))
        views.setOnClickPendingIntent(R.id.ivw_empty, openApp)
        return views
      }
      views.setViewVisibility(R.id.ivw_rows, View.VISIBLE)
      views.setViewVisibility(R.id.ivw_empty, View.GONE)
      val n = Widgets.listRows(context, options)
      // 刚勾掉的仍占着位置（画成已完成），等 JS 推来新列表才消失——别让下面的行突然跳上来
      for ((i, it) in items.take(n).withIndex()) {
        val row = RemoteViews(context.packageName, R.layout.ivw_todo_row)
        val done = store.isDone(it.key)
        row.setTextViewText(R.id.ivw_row_text, it.text.ifEmpty { it.raw })
        row.setTextViewText(R.id.ivw_row_note, it.title)
        row.setImageViewResource(R.id.ivw_row_check, if (done) R.drawable.ivw_ic_ring_done else R.drawable.ivw_ic_ring)
        row.setTextColor(R.id.ivw_row_text, ContextCompat.getColor(context, if (done) R.color.ivw_muted else R.color.ivw_text))
        row.setInt(
          R.id.ivw_row_text,
          "setPaintFlags",
          if (done) Paint.STRIKE_THRU_TEXT_FLAG or Paint.ANTI_ALIAS_FLAG else Paint.ANTI_ALIAS_FLAG
        )
        if (!done) {
          val toggle = Intent(context, TodoWidget::class.java)
            .setAction(ACTION_TOGGLE)
            // PendingIntent 判等不看 extras：data 只为了让每一条都是不同的 intent
            .setData(Uri.fromParts("ivtodo", "${it.path}#${it.line}", null))
            .putExtra(EXTRA_PATH, it.path)
            .putExtra(EXTRA_TITLE, it.title)
            .putExtra(EXTRA_LINE, it.line)
            .putExtra(EXTRA_RAW, it.raw)
            .putExtra(EXTRA_TEXT, it.text)
          row.setOnClickPendingIntent(R.id.ivw_row_check, Widgets.broadcast(context, requestCode * 64 + 2 + i, toggle))
        }
        row.setOnClickPendingIntent(
          R.id.ivw_row,
          Widgets.activity(context, requestCode * 64 + 2 + i, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_NOTE, vaultId, it.path))
        )
        views.addView(R.id.ivw_rows, row)
      }
      return views
    }
  }
}
