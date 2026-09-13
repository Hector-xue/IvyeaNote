package com.ivyea.note.launcher

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView

/**
 * 笔记卡片的配置页：从选择器添加卡片时系统先开它，让用户选一篇；长按卡片「重新配置」也进这里。
 *
 * 列表来自 [WidgetStore.noteList]（JS 每次文件列表变化都会推整份路径 / 标题 / 修改时间），
 * 所以 App 从没打开过时这里是空的，页面上说清楚。第一行是「最近打开的一篇（自动）」，
 * 选它等于不绑定（保持 v0.11.30 的默认行为）。
 *
 * 选定后：写绑定 → 已有快照就直接画；没有且库在磁盘上就原生读一遍先画个预览（[NativePreview]）；
 * 都没有就先显示"点一下打开这篇"，App 下次起来会推真正的快照。
 * 按安卓的约定，进来先 setResult(RESULT_CANCELED)，用户退出去就是取消，系统会把卡片删掉。
 */
class PickNoteActivity : Activity() {

  private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  private lateinit var store: WidgetStore
  private var all: List<WidgetStore.RecentItem> = emptyList()
  private lateinit var adapter: Adapter

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setResult(RESULT_CANCELED)
    widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
      finish()
      return
    }
    setContentView(R.layout.ivw_pick)
    store = WidgetStore(this)
    all = store.noteList().sortedByDescending { it.mtime }

    val list = findViewById<ListView>(R.id.ivw_pick_list)
    val empty = findViewById<TextView>(R.id.ivw_pick_empty)
    val search = findViewById<EditText>(R.id.ivw_pick_search)
    adapter = Adapter()
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ -> choose(adapter.items[position]) }
    if (all.isEmpty()) {
      list.visibility = View.GONE
      empty.visibility = View.VISIBLE
      search.visibility = View.GONE
    }
    search.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        adapter.filter(s?.toString() ?: "")
        empty.text = getString(R.string.ivw_pick_none)
        empty.visibility = if (adapter.items.isEmpty()) View.VISIBLE else View.GONE
        list.visibility = if (adapter.items.isEmpty()) View.GONE else View.VISIBLE
      }
    })
  }

  /** `item` 为 null = 「最近打开的一篇（自动）」 */
  private fun choose(item: WidgetStore.RecentItem?) {
    if (item == null) {
      store.unbind(intArrayOf(widgetId))
    } else {
      val b = WidgetStore.Binding(item.vaultId, item.path)
      store.bind(widgetId, b)
      if (store.snapshot(b) == null) {
        NativePreview.snapshot(this, store.notesRoot(), item.vaultId, item.path)?.let { store.putSnapshot(it, false) }
      }
    }
    NoteWidget.render(this, AppWidgetManager.getInstance(this), widgetId)
    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
    finish()
  }

  /** 第一行固定是「自动」（用 null 表示），后面是过滤后的笔记 */
  private inner class Adapter : BaseAdapter() {
    var items: List<WidgetStore.RecentItem?> = listOf<WidgetStore.RecentItem?>(null) + all

    fun filter(q: String) {
      val needle = q.trim().lowercase()
      items = if (needle.isEmpty()) {
        listOf<WidgetStore.RecentItem?>(null) + all
      } else {
        all.filter { it.title.lowercase().contains(needle) || it.path.lowercase().contains(needle) }
      }
      notifyDataSetChanged()
    }

    override fun getCount(): Int = items.size
    override fun getItem(position: Int): Any? = items[position]
    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
      val v = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.ivw_pick_row, parent, false)
      val title = v.findViewById<TextView>(R.id.ivw_pick_row_title)
      val sub = v.findViewById<TextView>(R.id.ivw_pick_row_sub)
      val it = items[position]
      if (it == null) {
        title.text = getString(R.string.ivw_pick_auto)
        sub.text = getString(R.string.ivw_pick_auto_sub)
      } else {
        title.text = it.title.ifEmpty { getString(R.string.ivw_untitled) }
        val dir = it.path.substringBeforeLast('/', "")
        val time = Widgets.relativeShort(this@PickNoteActivity, it.mtime)
        sub.text = if (dir.isEmpty()) time else "$dir · $time"
      }
      return v
    }
  }
}
