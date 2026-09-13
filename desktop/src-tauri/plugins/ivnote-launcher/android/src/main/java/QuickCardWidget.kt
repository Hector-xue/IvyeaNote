package com.ivyea.note.launcher

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

/**
 * 「快速记录」小部件（2×2）：日期 + 一句提示 + 底栏「今日日记」/ ＋。
 * 点卡片任何地方 = 新建笔记；底栏左边进今日日记。没有任何状态，日期由 TextClock 自己走。
 */
class QuickCardWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, build(context, id))
  }

  companion object {
    fun build(context: Context, requestCode: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.ivw_quick_card)
      val newNote = Widgets.activity(context, requestCode * 2, LaunchIntents.launch(context, LaunchIntents.ACTION_NEW_NOTE))
      views.setOnClickPendingIntent(R.id.ivw_root, newNote)
      views.setOnClickPendingIntent(R.id.ivw_new, newNote)
      views.setOnClickPendingIntent(
        R.id.ivw_daily,
        Widgets.activity(context, requestCode * 2 + 1, LaunchIntents.launch(context, LaunchIntents.ACTION_DAILY))
      )
      return views
    }
  }
}
