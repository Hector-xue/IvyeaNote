package com.ivyea.note.launcher

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

/**
 * 「快捷创建」小部件（2×1）：左半边打开应用，右边那个 ＋ 直接新建一篇笔记。
 * 没有任何状态，画法固定。
 */
class QuickWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, build(context, id))
  }

  companion object {
    fun build(context: Context, requestCode: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.ivw_quick)
      views.setOnClickPendingIntent(
        R.id.ivw_quick_open,
        NoteWidget.activity(context, requestCode * 2, LaunchIntents.launch(context, LaunchIntents.ACTION_OPEN_APP))
      )
      views.setOnClickPendingIntent(
        R.id.ivw_quick_new,
        NoteWidget.activity(context, requestCode * 2 + 1, LaunchIntents.launch(context, LaunchIntents.ACTION_NEW_NOTE))
      )
      return views
    }
  }
}
