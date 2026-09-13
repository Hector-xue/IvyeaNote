package com.ivyea.note.launcher

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 几个小部件共用的小工具：相对时间、按高度算行数、PendingIntent */
object Widgets {

  private val HM = SimpleDateFormat("HH:mm", Locale.getDefault())
  private val MD = SimpleDateFormat("M月d日", Locale.getDefault())
  private val YMD = SimpleDateFormat("yyyy年M月d日", Locale.getDefault())
  private val WEEKDAY = SimpleDateFormat("EEE", Locale.getDefault())

  /**
   * 笔记卡片底栏用的相对时间：刚刚 / 12 分钟前 / 今天 09:31 / 昨天 21:40 / 9月8日 14:02 / 2025年12月3日。
   */
  fun relativeLong(context: Context, mtime: Long, now: Long = System.currentTimeMillis()): String {
    if (mtime <= 0L) return ""
    val res = context.resources
    val diff = now - mtime
    if (diff in 0 until 60_000L) return res.getString(R.string.ivw_time_now)
    if (diff in 0 until 3_600_000L) return res.getString(R.string.ivw_time_minutes, (diff / 60_000L).toInt())
    val days = dayDistance(mtime, now)
    val hm = HM.format(Date(mtime))
    return when {
      days == 0 -> res.getString(R.string.ivw_time_today, hm)
      days == 1 -> res.getString(R.string.ivw_time_yesterday, hm)
      sameYear(mtime, now) -> "${MD.format(Date(mtime))} $hm"
      else -> YMD.format(Date(mtime))
    }
  }

  /** 列表行右端的短版：09:31 / 昨天 / 周三 / 9月8日 / 2025年12月3日 */
  fun relativeShort(context: Context, mtime: Long, now: Long = System.currentTimeMillis()): String {
    if (mtime <= 0L) return ""
    val res = context.resources
    val days = dayDistance(mtime, now)
    return when {
      days == 0 -> HM.format(Date(mtime))
      days == 1 -> res.getString(R.string.ivw_time_yesterday, "").trim()
      days in 2..6 -> WEEKDAY.format(Date(mtime))
      sameYear(mtime, now) -> MD.format(Date(mtime))
      else -> YMD.format(Date(mtime))
    }
  }

  /** 两个时刻隔了几个"日历日"（按本地时区的零点算，不是 24 小时） */
  private fun dayDistance(then: Long, now: Long): Int {
    val a = Calendar.getInstance().apply { timeInMillis = then }
    val b = Calendar.getInstance().apply { timeInMillis = now }
    val ay = a.get(Calendar.YEAR)
    val by = b.get(Calendar.YEAR)
    val ad = a.get(Calendar.DAY_OF_YEAR)
    val bd = b.get(Calendar.DAY_OF_YEAR)
    if (ay == by) return bd - ad
    // 跨年：用毫秒差粗算就够（只影响"昨天/周几"的判断，跨年那几天差一天无伤大雅）
    val aMid = a.apply { set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis
    val bMid = b.apply { set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis
    return ((bMid - aMid) / 86_400_000L).toInt()
  }

  private fun sameYear(a: Long, b: Long): Boolean {
    val ca = Calendar.getInstance().apply { timeInMillis = a }
    val cb = Calendar.getInstance().apply { timeInMillis = b }
    return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR)
  }

  /**
   * 列表类小部件能放几行：小部件高度(dp) 去掉内边距和标题行，再除以行高（含 1dp 分割线）。
   * `OPTION_APPWIDGET_MIN_HEIGHT` 是竖屏下的高度；`options` 为 null（选择器预览）时给 3 行。
   * 文字是 sp，用户把系统字体调大时行高和标题行都跟着长，要按 fontScale 缩。
   */
  fun listRows(context: Context, options: Bundle?, max: Int = 8): Int {
    val minH = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0
    if (minH <= 0) return 3
    val res = context.resources
    fun dp(id: Int) = res.getDimension(id) / res.displayMetrics.density
    val scale = res.configuration.fontScale.coerceAtLeast(1f)
    val fixed = 16f + dp(R.dimen.ivw_list_header_h) * scale
    val row = dp(R.dimen.ivw_row_h) * scale + 1f
    return ((minH - fixed) / row).toInt().coerceIn(2, max)
  }

  /** 点击用的 PendingIntent（打开 Activity）：内容固定、系统不需要往里填东西 → IMMUTABLE */
  fun activity(context: Context, requestCode: Int, intent: Intent): PendingIntent {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(context, requestCode, intent, flags)
  }

  /** 发给本应用某个 receiver 的广播（待办勾选走这条） */
  fun broadcast(context: Context, requestCode: Int, intent: Intent): PendingIntent {
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(context, requestCode, intent, flags)
  }
}
