package com.ivyea.note.launcher

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews

/**
 * 「最近笔记」小部件（4×2 起，可拉高）：最近打开的几篇，一行一篇，点哪行开哪篇。
 * 列表由 JS 推（[WidgetStore.putRecentList]），行数按小部件高度算；右上角 ＋ 新建。
 */
class RecentWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) render(context, manager, id)
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    render(context, manager, id)
  }

  companion object {
    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      for (id in manager.getAppWidgetIds(ComponentName(context, RecentWidget::class.java))) render(context, manager, id)
    }

    fun render(context: Context, manager: AppWidgetManager, id: Int) {
      manager.updateAppWidget(id, build(context, WidgetStore(context).recentList(), manager.getAppWidgetOptions(id), id))
    }

    fun build(context: Context, items: List<WidgetStore.RecentItem>, options: Bundle?, requestCode: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.ivw_list)
      val res = context.resources
      views.setTextViewText(R.id.ivw_head, res.getString(R.string.ivw_recent_widget_label))
      views.setViewVisibility(R.id.ivw_count, View.GONE)
      views.setOnClickPendingIntent(
        R.id.ivw_new,
        Widgets.activity(context, requestCode * 16, LaunchIntents.launch(context, LaunchIntents.ACTION_NEW_NOTE))
      )
      views.setOnClickPendingIntent(
        R.id.ivw_header,
        Widgets.activity(context, requestCode * 16 + 1, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_APP))
      )
      views.removeAllViews(R.id.ivw_rows)
      if (items.isEmpty()) {
        views.setViewVisibility(R.id.ivw_rows, View.GONE)
        views.setViewVisibility(R.id.ivw_empty, View.VISIBLE)
        views.setTextViewText(R.id.ivw_empty, res.getString(R.string.ivw_recent_empty))
        views.setOnClickPendingIntent(
          R.id.ivw_empty,
          Widgets.activity(context, requestCode * 16 + 1, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_APP))
        )
        return views
      }
      views.setViewVisibility(R.id.ivw_rows, View.VISIBLE)
      views.setViewVisibility(R.id.ivw_empty, View.GONE)
      val n = Widgets.listRows(context, options)
      for ((i, it) in items.take(n).withIndex()) {
        val row = RemoteViews(context.packageName, R.layout.ivw_recent_row)
        row.setTextViewText(R.id.ivw_row_title, it.title.ifEmpty { res.getString(R.string.ivw_untitled) })
        row.setTextViewText(R.id.ivw_row_time, Widgets.relativeShort(context, it.mtime))
        row.setOnClickPendingIntent(
          R.id.ivw_row,
          Widgets.activity(context, requestCode * 16 + 2 + i, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_NOTE, it.vaultId, it.path))
        )
        views.addView(R.id.ivw_rows, row)
      }
      return views
    }
  }
}
