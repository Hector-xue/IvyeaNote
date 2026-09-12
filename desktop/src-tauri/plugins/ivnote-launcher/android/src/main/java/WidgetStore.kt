package com.ivyea.note.launcher

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * 小部件的全部持久状态，一个 SharedPreferences 文件：
 *
 * - `bind.<appWidgetId>`  = `<vaultId>|<path>`   —— 这张卡片钉的是哪篇
 * - `snap.<vaultId>|<path>` = JSON{title,preview,mtime} —— 那篇的快照（JS 推来的）
 * - `snap.recent`           = 同上 + vaultId/path   —— 最近打开的一篇（没绑定的卡片显示它）
 * - `pin.*`                 —— 「添加到桌面」进行中的那篇（成功回调 / 手动添加时据此绑定）
 *
 * 为什么是快照而不是现读文件：见 Rust 侧 lib.rs 开头。
 * 为什么是 SharedPreferences：小部件在 App 进程没起来时也会被系统要求重画
 * （开机、换启动器、改尺寸），必须有一份不依赖 WebView 的数据。
 */
class WidgetStore(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  data class Snapshot(
    val vaultId: Long,
    val path: String,
    val title: String,
    val preview: String,
    val mtime: Long,
  ) {
    fun toJson(): String {
      val o = JSONObject()
      o.put("vaultId", vaultId)
      o.put("path", path)
      o.put("title", title)
      o.put("preview", preview)
      o.put("mtime", mtime)
      return o.toString()
    }

    companion object {
      fun fromJson(raw: String?): Snapshot? {
        if (raw.isNullOrEmpty()) return null
        return try {
          val o = JSONObject(raw)
          Snapshot(
            o.optLong("vaultId", 0L),
            o.optString("path", ""),
            o.optString("title", ""),
            o.optString("preview", ""),
            o.optLong("mtime", 0L),
          )
        } catch (ex: Exception) {
          null
        }
      }
    }
  }

  data class Binding(val vaultId: Long, val path: String) {
    val key: String get() = "$vaultId|$path"
  }

  // ---------------------------------------------------------------- 绑定

  fun binding(appWidgetId: Int): Binding? = parseBinding(prefs.getString(bindKey(appWidgetId), null))

  fun bind(appWidgetId: Int, b: Binding) {
    prefs.edit().putString(bindKey(appWidgetId), b.key).apply()
  }

  fun unbind(appWidgetIds: IntArray) {
    val e = prefs.edit()
    for (id in appWidgetIds) e.remove(bindKey(id))
    e.apply()
  }

  /** 所有绑定：appWidgetId -> Binding */
  fun allBindings(): Map<Int, Binding> {
    val out = HashMap<Int, Binding>()
    for ((k, v) in prefs.all) {
      if (!k.startsWith(BIND_PREFIX)) continue
      val id = k.substring(BIND_PREFIX.length).toIntOrNull() ?: continue
      val b = parseBinding(v as? String) ?: continue
      out[id] = b
    }
    return out
  }

  /** 绑到某篇的小部件 id 列表 */
  fun widgetsBoundTo(b: Binding): List<Int> = allBindings().filter { it.value == b }.map { it.key }

  /**
   * 改名 / 移动 / 库 id 变化：把绑定换成新的，顺手把旧快照挪过去，
   * 这样卡片在 JS 推来新快照之前不会闪一下"已不在库里"。
   */
  fun rebind(from: Binding, to: Binding) {
    if (from == to) return
    val e = prefs.edit()
    var touched = false
    for ((id, b) in allBindings()) {
      if (b == from) {
        e.putString(bindKey(id), to.key)
        touched = true
      }
    }
    val snap = prefs.getString(snapKey(from), null)
    if (snap != null) {
      Snapshot.fromJson(snap)?.let {
        e.putString(snapKey(to), it.copy(vaultId = to.vaultId, path = to.path).toJson())
      }
      e.remove(snapKey(from))
      touched = true
    }
    val recent = recent()
    if (recent != null && recent.vaultId == from.vaultId && recent.path == from.path) {
      e.putString(KEY_RECENT, recent.copy(vaultId = to.vaultId, path = to.path).toJson())
      touched = true
    }
    if (touched) e.apply()
  }

  // ---------------------------------------------------------------- 快照

  fun snapshot(b: Binding): Snapshot? = Snapshot.fromJson(prefs.getString(snapKey(b), null))

  fun putSnapshot(s: Snapshot, recent: Boolean) {
    val e = prefs.edit()
    e.putString(snapKey(Binding(s.vaultId, s.path)), s.toJson())
    if (recent) e.putString(KEY_RECENT, s.toJson())
    e.apply()
  }

  fun recent(): Snapshot? = Snapshot.fromJson(prefs.getString(KEY_RECENT, null))

  /**
   * 只留还被引用的快照（各绑定 + recent），别的删掉。
   * 快照随打开 / 保存不断写入，不清理的话这个文件会跟着"打开过的笔记数"一直长。
   */
  fun pruneSnapshots() {
    val keep = HashSet<String>()
    for (b in allBindings().values) keep.add(snapKey(b))
    recent()?.let { keep.add(snapKey(Binding(it.vaultId, it.path))) }
    val e = prefs.edit()
    var touched = false
    for (k in prefs.all.keys) {
      if (k.startsWith(SNAP_PREFIX) && k != KEY_RECENT && k !in keep) {
        e.remove(k)
        touched = true
      }
    }
    if (touched) e.apply()
  }

  // ---------------------------------------------------------------- 添加到桌面（进行中）

  /** 记下"正在把这篇放到桌面"；成功回调 / 之后 [PENDING_TTL_MS] 内新出现的卡片绑到它 */
  fun setPendingPin(b: Binding) {
    prefs.edit().putString(KEY_PENDING, b.key).putLong(KEY_PENDING_AT, System.currentTimeMillis()).apply()
  }

  fun takePendingPin(): Binding? {
    val b = parseBinding(prefs.getString(KEY_PENDING, null))
    val at = prefs.getLong(KEY_PENDING_AT, 0L)
    prefs.edit().remove(KEY_PENDING).remove(KEY_PENDING_AT).apply()
    if (b == null) return null
    return if (System.currentTimeMillis() - at <= PENDING_TTL_MS) b else null
  }

  /** 看一眼但不领走（成功回调之外，新卡片 onUpdate 时也要能用到同一份） */
  fun peekPendingPin(): Binding? {
    val b = parseBinding(prefs.getString(KEY_PENDING, null)) ?: return null
    val at = prefs.getLong(KEY_PENDING_AT, 0L)
    return if (System.currentTimeMillis() - at <= PENDING_TTL_MS) b else null
  }

  // ---------------------------------------------------------------- 内部

  private fun bindKey(id: Int) = "$BIND_PREFIX$id"
  private fun snapKey(b: Binding) = "$SNAP_PREFIX${b.key}"

  private fun parseBinding(raw: String?): Binding? {
    if (raw.isNullOrEmpty()) return null
    val bar = raw.indexOf('|')
    if (bar <= 0) return null
    val vaultId = raw.substring(0, bar).toLongOrNull() ?: return null
    val path = raw.substring(bar + 1)
    if (path.isEmpty()) return null
    return Binding(vaultId, path)
  }

  companion object {
    private const val PREFS = "ivnote-launcher"
    private const val BIND_PREFIX = "bind."
    private const val SNAP_PREFIX = "snap."
    private const val KEY_RECENT = "snap.recent"
    private const val KEY_PENDING = "pin.binding"
    private const val KEY_PENDING_AT = "pin.at"
    /** 手动添加小部件要长按桌面、翻列表、拖放，给足十分钟 */
    const val PENDING_TTL_MS = 10 * 60 * 1000L
  }
}
