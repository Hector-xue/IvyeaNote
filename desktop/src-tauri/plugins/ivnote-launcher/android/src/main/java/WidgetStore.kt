package com.ivyea.note.launcher

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * 小部件的全部持久状态，一个 SharedPreferences 文件：
 *
 * - `bind.<appWidgetId>`  = `<vaultId>|<path>`   —— 这张卡片钉的是哪篇
 * - `snap.<vaultId>|<path>` = JSON{title,preview,mtime} —— 那篇的快照（JS 推来的）
 * - `snap.recent`           = 同上 + vaultId/path   —— 最近打开的一篇（没绑定的卡片显示它）
 * - `pin.*`                 —— 「添加到桌面」进行中的那篇（成功回调 / 手动添加时据此绑定）
 * - `list.recent`           = JSON[{vaultId,path,title,mtime}] —— 「最近笔记」小部件的几行
 * - `todo.items` / `todo.vaultId` / `todo.root` —— 「待办」小部件：未完成的事项、来自哪个库、
 *   库在磁盘上的位置（`content://` 树或绝对路径；OPFS 时是 `opfs://…`，原生写不了）
 * - `todo.pending`          = JSON[item] —— 在桌面上勾掉了、但还没落到文件里的（等 App 起来处理）
 * - `todo.done`             = JSON{key:ts} —— 刚勾掉的（先画成已完成，等 JS 推来新列表再说）
 * - `notes.items` / `notes.vaultId` / `notes.root` —— 当前库的全部笔记（路径 / 标题 / 修改时间），
 *   笔记卡片的配置页（PickNoteActivity）从这里列给用户选；root 同 todo.root
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

  // ---------------------------------------------------------------- 最近笔记（列表）

  data class RecentItem(val vaultId: Long, val path: String, val title: String, val mtime: Long)

  fun putRecentList(items: List<RecentItem>) {
    val arr = JSONArray()
    for (it in items) {
      val o = JSONObject()
      o.put("vaultId", it.vaultId)
      o.put("path", it.path)
      o.put("title", it.title)
      o.put("mtime", it.mtime)
      arr.put(o)
    }
    prefs.edit().putString(KEY_RECENT_LIST, arr.toString()).apply()
  }

  fun recentList(): List<RecentItem> {
    val raw = prefs.getString(KEY_RECENT_LIST, null) ?: return emptyList()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        RecentItem(o.optLong("vaultId", 0L), o.optString("path", ""), o.optString("title", ""), o.optLong("mtime", 0L))
      }.filter { it.path.isNotEmpty() }
    } catch (ex: Exception) {
      emptyList()
    }
  }

  // ---------------------------------------------------------------- 全部笔记（配置页选用）

  fun putNoteList(vaultId: Long, root: String, items: List<RecentItem>) {
    val arr = JSONArray()
    for (it in items) {
      val o = JSONObject()
      o.put("path", it.path)
      o.put("title", it.title)
      o.put("mtime", it.mtime)
      arr.put(o)
    }
    prefs.edit()
      .putLong(KEY_NOTES_VAULT, vaultId)
      .putString(KEY_NOTES_ROOT, root)
      .putString(KEY_NOTES_ITEMS, arr.toString())
      .apply()
  }

  fun noteList(): List<RecentItem> {
    val raw = prefs.getString(KEY_NOTES_ITEMS, null) ?: return emptyList()
    val vaultId = notesVaultId()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        RecentItem(vaultId, o.optString("path", ""), o.optString("title", ""), o.optLong("mtime", 0L))
      }.filter { it.path.isNotEmpty() }
    } catch (ex: Exception) {
      emptyList()
    }
  }

  fun notesVaultId(): Long = prefs.getLong(KEY_NOTES_VAULT, 0L)
  fun notesRoot(): String = prefs.getString(KEY_NOTES_ROOT, "") ?: ""

  // ---------------------------------------------------------------- 待办

  /**
   * 一条待办。`raw` 是 Markdown 里 `- [ ]` 后面的原文（改文件时拿它核对那一行），
   * `text` 是剥掉记号后给人看的。`line` 是 0 起的行号。
   */
  data class TodoItem(val path: String, val title: String, val line: Int, val raw: String, val text: String) {
    /** 同一条事项的身份：路径 + 行号 + 原文 */
    val key: String get() = "$path\u0000$line\u0000$raw"

    fun toJson(): JSONObject {
      val o = JSONObject()
      o.put("path", path)
      o.put("title", title)
      o.put("line", line)
      o.put("raw", raw)
      o.put("text", text)
      return o
    }

    companion object {
      fun fromJson(o: JSONObject): TodoItem? {
        val path = o.optString("path", "")
        if (path.isEmpty()) return null
        return TodoItem(path, o.optString("title", ""), o.optInt("line", -1), o.optString("raw", ""), o.optString("text", ""))
      }

      fun listFromJson(raw: String?): List<TodoItem> {
        if (raw.isNullOrEmpty()) return emptyList()
        return try {
          val arr = JSONArray(raw)
          (0 until arr.length()).mapNotNull { fromJson(arr.getJSONObject(it)) }
        } catch (ex: Exception) {
          emptyList()
        }
      }

      fun listToJson(items: List<TodoItem>): String {
        val arr = JSONArray()
        for (it in items) arr.put(it.toJson())
        return arr.toString()
      }
    }
  }

  /** JS 推来整份待办列表：替换 items，清掉"刚勾掉"的标记（队列里还没处理的那些照旧画成已完成） */
  fun putTodoSnapshot(vaultId: Long, root: String, items: List<TodoItem>) {
    prefs.edit()
      .putLong(KEY_TODO_VAULT, vaultId)
      .putString(KEY_TODO_ROOT, root)
      .putString(KEY_TODO_ITEMS, TodoItem.listToJson(items))
      .remove(KEY_TODO_DONE)
      .apply()
  }

  fun todoItems(): List<TodoItem> = TodoItem.listFromJson(prefs.getString(KEY_TODO_ITEMS, null))
  fun todoVaultId(): Long = prefs.getLong(KEY_TODO_VAULT, 0L)
  fun todoRoot(): String = prefs.getString(KEY_TODO_ROOT, "") ?: ""

  /** 原生已经把这条写进文件了：从列表里拿掉 */
  fun removeTodoItem(key: String) {
    val rest = todoItems().filter { it.key != key }
    prefs.edit().putString(KEY_TODO_ITEMS, TodoItem.listToJson(rest)).apply()
  }

  /** 刚在桌面上勾掉：先画成已完成。超过 [DONE_TTL_MS] 没被新列表确认就当没勾成 */
  fun markDone(key: String) {
    val map = doneMap()
    val now = System.currentTimeMillis()
    val it = map.keys()
    val stale = ArrayList<String>()
    while (it.hasNext()) {
      val k = it.next()
      if (now - map.optLong(k, 0L) > DONE_TTL_MS) stale.add(k)
    }
    for (k in stale) map.remove(k)
    map.put(key, now)
    prefs.edit().putString(KEY_TODO_DONE, map.toString()).apply()
  }

  fun isDone(key: String): Boolean {
    val at = doneMap().optLong(key, 0L)
    if (at > 0L && System.currentTimeMillis() - at <= DONE_TTL_MS) return true
    return pendingToggles().any { it.key == key }
  }

  private fun doneMap(): JSONObject = try {
    JSONObject(prefs.getString(KEY_TODO_DONE, null) ?: "{}")
  } catch (ex: Exception) {
    JSONObject()
  }

  /**
   * 原生写不了（库在 OPFS 里 / 那一行对不上）：排队，App 起来后领走处理。
   * 队列里每条多记一个 vaultId（当时列表属于哪个库），JS 据此判断是不是当前库的。
   */
  fun queuePendingToggle(item: TodoItem, vaultId: Long) {
    val arr = JSONArray()
    for (o in pendingRaw()) {
      if (TodoItem.fromJson(o)?.key != item.key) arr.put(o)
    }
    arr.put(item.toJson().put("vaultId", vaultId))
    prefs.edit().putString(KEY_TODO_PENDING, arr.toString()).apply()
  }

  fun pendingToggles(): List<TodoItem> = pendingRaw().mapNotNull { TodoItem.fromJson(it) }

  /** 领走即清空；原样交出（带 vaultId） */
  fun takePendingToggles(): JSONArray {
    val arr = JSONArray()
    for (o in pendingRaw()) arr.put(o)
    if (arr.length() > 0) prefs.edit().remove(KEY_TODO_PENDING).apply()
    return arr
  }

  private fun pendingRaw(): List<JSONObject> {
    val raw = prefs.getString(KEY_TODO_PENDING, null) ?: return emptyList()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).map { arr.getJSONObject(it) }
    } catch (ex: Exception) {
      emptyList()
    }
  }

  companion object {
    private const val PREFS = "ivnote-launcher"
    private const val KEY_RECENT_LIST = "list.recent"
    private const val KEY_TODO_ITEMS = "todo.items"
    private const val KEY_TODO_VAULT = "todo.vaultId"
    private const val KEY_TODO_ROOT = "todo.root"
    private const val KEY_TODO_PENDING = "todo.pending"
    private const val KEY_TODO_DONE = "todo.done"
    private const val KEY_NOTES_ITEMS = "notes.items"
    private const val KEY_NOTES_VAULT = "notes.vaultId"
    private const val KEY_NOTES_ROOT = "notes.root"
    /** 勾掉之后多久没被新列表确认就恢复成未完成 */
    const val DONE_TTL_MS = 90 * 1000L
    private const val BIND_PREFIX = "bind."
    private const val SNAP_PREFIX = "snap."
    private const val KEY_RECENT = "snap.recent"
    private const val KEY_PENDING = "pin.binding"
    private const val KEY_PENDING_AT = "pin.at"
    /** 手动添加小部件要长按桌面、翻列表、拖放，给足十分钟 */
    const val PENDING_TTL_MS = 10 * 60 * 1000L
  }
}
