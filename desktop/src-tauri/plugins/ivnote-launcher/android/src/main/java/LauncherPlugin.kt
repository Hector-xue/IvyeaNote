package com.ivyea.note.launcher

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ShortcutSpecArg {
  lateinit var kind: String
  lateinit var label: String
  var vaultId: Long = 0L
  var path: String = ""
}

@InvokeArg
class ShortcutsArg {
  var shortcuts: List<ShortcutSpecArg> = emptyList()
}

@InvokeArg
class SnapshotArg {
  var vaultId: Long = 0L
  lateinit var path: String
  var title: String = ""
  var preview: String = ""
  var mtime: Long = 0L
  var recent: Boolean = false
}

@InvokeArg
class RebindOpArg {
  var fromVaultId: Long = 0L
  lateinit var from: String
  var toVaultId: Long = 0L
  lateinit var to: String
}

@InvokeArg
class RebindArg {
  var ops: List<RebindOpArg> = emptyList()
}

@InvokeArg
class RecentItemArg {
  var vaultId: Long = 0L
  lateinit var path: String
  var title: String = ""
  var mtime: Long = 0L
}

@InvokeArg
class RecentListArg {
  var items: List<RecentItemArg> = emptyList()
}

@InvokeArg
class TodoItemArg {
  // Rust 侧 TodoItem 带 vaultId（队列条目用），推列表时是 0，这里收下不用
  var vaultId: Long = 0L
  lateinit var path: String
  var title: String = ""
  var line: Int = -1
  var raw: String = ""
  var text: String = ""
}

@InvokeArg
class TodoSnapshotArg {
  var vaultId: Long = 0L
  var root: String = ""
  var items: List<TodoItemArg> = emptyList()
}

@InvokeArg
class TodoLiveArg {
  var live: Boolean = false
}

/**
 * 桌面入口的插件本体：接住「从快捷方式 / 小部件进来」的 intent，
 * 并把 JS 推来的快捷方式列表 / 笔记快照 / 最近列表 / 待办列表交给系统。
 *
 * ## intent 是怎么接到的（这是这个文件最要紧的一段）
 *
 * Tauri 的 PluginManager 只记**第一个** Activity，插件实例每个进程只建一次。
 * 于是有三种进来的方式，缺一条都会"点了没反应"：
 *
 * 1. **冷启动**：进程从无到有。插件在 [load] 里读构造时拿到的 `activity.intent`。
 * 2. **热启动**：Activity 活着（singleTask）→ 系统调 onNewIntent → TauriActivity 转给
 *    PluginManager → [onNewIntent]。
 * 3. **温启动**：进程还在、Activity 已经没了（用户按返回退出了，系统没回收进程）。
 *    系统新建一个 MainActivity 并把 intent 交给它的 onCreate——**既不会再来 [load]，
 *    也没有 onNewIntent**，PluginManager 手里那个 activity 还是旧的。
 *    所以这里在构造时向 Application 注册 [Application.ActivityLifecycleCallbacks]，
 *    每个新建的启动 Activity 都能被看见。
 *
 * 同一个 Intent 对象可能被 1 和 3 各看一眼，`LaunchIntents.consume` 用标记去重。
 *
 * 领取是**拉**模型：动作先放在 [pending]，JS 起来（或收到 `launch` 事件）后调
 * takeLaunchAction 领走。不能只靠事件推——冷启动时 JS 还没起来，推了也没人听。
 */
@TauriPlugin
class LauncherPlugin(private val activity: Activity) : Plugin(activity) {

  @Volatile
  private var pending: LaunchIntents.Action? = null

  private val app: Context = activity.applicationContext

  init {
    instance = this
    (activity.application as Application).registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {
          // 只看我们的启动 Activity；带 savedInstanceState 的是系统重建（转屏、回收后恢复），
          // 那时候 intent 是旧的，不该再执行一遍
          if (a.javaClass != activity.javaClass || savedInstanceState != null) return
          accept(LaunchIntents.consume(a.intent))
        }
        override fun onActivityStarted(a: Activity) {}
        override fun onActivityResumed(a: Activity) {}
        override fun onActivityPaused(a: Activity) {}
        override fun onActivityStopped(a: Activity) {}
        override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(a: Activity) {
          // WebView 随 Activity 一起没了：JS 不在了，待办的勾选别再往它那边发
          if (a.javaClass == activity.javaClass) todoLive = false
        }
      }
    )
  }

  override fun load(webView: WebView) {
    // 冷启动：把这个进程第一个 Activity 的 intent 收进来
    accept(LaunchIntents.consume(activity.intent))
  }

  override fun onNewIntent(intent: Intent) {
    accept(LaunchIntents.consume(intent))
  }

  private fun accept(action: LaunchIntents.Action?) {
    if (action == null) return
    pending = action
    // JS 若已在跑，立刻通知它来领；没在跑也无妨，起来后会主动来领
    trigger("launch", action.toJS())
  }

  // ---------------------------------------------------------------- 命令

  @Command
  fun takeLaunchAction(invoke: Invoke) {
    val a = pending
    pending = null
    val res = JSObject()
    res.put("action", a?.toJS())
    invoke.resolve(res)
  }

  @Command
  fun setShortcuts(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShortcutsArg::class.java)
      Shortcuts.publish(app, args.shortcuts.map { Shortcuts.Spec(it.kind, it.label, it.vaultId, it.path) })
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "发布快捷方式失败")
    }
  }

  @Command
  fun setNoteSnapshot(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(SnapshotArg::class.java)
      val store = WidgetStore(app)
      val snap = WidgetStore.Snapshot(a.vaultId, a.path, a.title, a.preview, a.mtime)
      store.putSnapshot(snap, a.recent)
      NoteWidget.updateShowing(app, WidgetStore.Binding(a.vaultId, a.path))
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "更新小部件失败")
    }
  }

  @Command
  fun boundNotes(invoke: Invoke) {
    val store = WidgetStore(app)
    val arr = JSArray()
    for (b in store.allBindings().values.toSet()) {
      val o = JSObject()
      o.put("vaultId", b.vaultId)
      o.put("path", b.path)
      arr.put(o)
    }
    val res = JSObject()
    res.put("notes", arr)
    invoke.resolve(res)
  }

  @Command
  fun rebindNotes(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(RebindArg::class.java)
      val store = WidgetStore(app)
      for (op in args.ops) {
        store.rebind(
          WidgetStore.Binding(op.fromVaultId, op.from),
          WidgetStore.Binding(op.toVaultId, op.to)
        )
      }
      NoteWidget.updateAll(app)
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "更新小部件绑定失败")
    }
  }

  /**
   * 把一篇笔记放到桌面上。三条路，按可用性依次退：
   * - 启动器支持一键添加（API 26+ 且 `isRequestPinAppWidgetSupported`）→ 弹系统确认框，
   *   确认后系统回调 [NoteWidget.ACTION_PIN_DONE]，那边把新卡片绑到这篇；
   * - 不支持，但桌面上已有没绑笔记的卡片 → 直接绑上；
   * - 都没有 → 记下来，十分钟内用户手动添加的下一张卡片绑到这篇。
   */
  @Command
  fun pinNoteWidget(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(SnapshotArg::class.java)
      val store = WidgetStore(app)
      val binding = WidgetStore.Binding(a.vaultId, a.path)
      val snap = WidgetStore.Snapshot(a.vaultId, a.path, a.title, a.preview, a.mtime)
      store.putSnapshot(snap, false)
      store.setPendingPin(binding)

      val manager = AppWidgetManager.getInstance(app)
      val res = JSObject()
      if (Build.VERSION.SDK_INT >= 26 && manager.isRequestPinAppWidgetSupported) {
        val provider = ComponentName(app, NoteWidget::class.java)
        val extras = Bundle()
        // 确认框里直接预览这篇，而不是一张空卡
        extras.putParcelable(AppWidgetManager.EXTRA_APPWIDGET_PREVIEW, NoteWidget.build(app, binding, snap, null, 0))
        // 成功回调：系统要往里填 EXTRA_APPWIDGET_ID → 必须可变（31+ 要显式声明）
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        flags = if (Build.VERSION.SDK_INT >= 31) flags or PendingIntent.FLAG_MUTABLE else flags
        val callback = PendingIntent.getBroadcast(
          app,
          0,
          Intent(app, NoteWidget::class.java).setAction(NoteWidget.ACTION_PIN_DONE),
          flags
        )
        val ok = manager.requestPinAppWidget(provider, extras, callback)
        if (ok) {
          res.put("mode", "requested")
          res.put("count", 0)
          invoke.resolve(res)
          return
        }
      }
      // 退路：绑到桌面上已有的、还没绑笔记的卡片
      val free = manager.getAppWidgetIds(ComponentName(app, NoteWidget::class.java))
        .filter { store.binding(it) == null }
      if (free.isNotEmpty()) {
        for (id in free) store.bind(id, binding)
        store.takePendingPin()
        NoteWidget.updateAll(app)
        res.put("mode", "bound")
        res.put("count", free.size)
      } else {
        res.put("mode", "pending")
        res.put("count", 0)
      }
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "添加到桌面失败")
    }
  }

  // ---------------------------------------------------------------- 最近笔记 / 待办

  @Command
  fun setRecentNotes(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(RecentListArg::class.java)
      WidgetStore(app).putRecentList(a.items.map { WidgetStore.RecentItem(it.vaultId, it.path, it.title, it.mtime) })
      RecentWidget.updateAll(app)
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "更新最近笔记失败")
    }
  }

  @Command
  fun setTodoSnapshot(invoke: Invoke) {
    try {
      val a = invoke.parseArgs(TodoSnapshotArg::class.java)
      WidgetStore(app).putTodoSnapshot(
        a.vaultId,
        a.root,
        a.items.map { WidgetStore.TodoItem(it.path, it.title, it.line, it.raw, it.text) }
      )
      TodoWidget.updateAll(app)
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "更新待办失败")
    }
  }

  /** 桌面上勾掉了、原生没能写进文件的那些：JS 起来后领走处理（领走即清空） */
  @Command
  fun takePendingToggles(invoke: Invoke) {
    val res = JSObject()
    res.put("items", WidgetStore(app).takePendingToggles())
    invoke.resolve(res)
  }

  /** JS 告诉原生"我在听 todo 事件"（true）/ 卸载了（false） */
  @Command
  fun setTodoLive(invoke: Invoke) {
    try {
      todoLive = invoke.parseArgs(TodoLiveArg::class.java).live
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "参数错误")
    }
  }

  companion object {
    /** 每个进程只有一个插件实例（PluginManager 只建一次） */
    @Volatile
    private var instance: LauncherPlugin? = null

    /** JS 那边的 useLauncher 正挂着、能接 todo 事件 */
    @Volatile
    var todoLive: Boolean = false

    /**
     * 桌面上勾掉了一条待办：App 活着就交给 JS（返回 true），JS 改文件后会推来新列表。
     * 不在就返回 false，由 TodoWidget 自己想办法。
     */
    fun notifyTodoToggle(vaultId: Long, item: WidgetStore.TodoItem): Boolean {
      val p = instance ?: return false
      if (!todoLive) return false
      val o = JSObject()
      o.put("vaultId", vaultId)
      o.put("path", item.path)
      o.put("title", item.title)
      o.put("line", item.line)
      o.put("raw", item.raw)
      o.put("text", item.text)
      p.trigger("todo", o)
      return true
    }
  }
}
