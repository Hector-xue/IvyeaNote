package com.ivyea.note.launcher

import android.content.Context
import android.content.Intent
import app.tauri.plugin.JSObject

/**
 * 「从桌面进来时要做什么」在 intent 上的编码，快捷方式和小部件共用。
 *
 * 全部走**显式** intent（component 指向本应用的启动 Activity），action 只是我们自己的
 * 标记，所以不需要在 manifest 上声明 intent-filter，也不会被别的应用截走。
 * 启动 Activity 是 `singleTask`：应用活着就走 onNewIntent，没活着就走 onCreate，
 * 两条路 LauncherPlugin 都接（见那边的注释）。
 */
object LaunchIntents {
  const val ACTION_NEW_NOTE = "com.ivyea.note.action.NEW_NOTE"
  const val ACTION_DAILY = "com.ivyea.note.action.DAILY"
  const val ACTION_OPEN_NOTE = "com.ivyea.note.action.OPEN_NOTE"
  /** 只是打开应用（快捷创建小部件的左半边）；JS 那边不做任何事 */
  const val ACTION_OPEN_APP = "com.ivyea.note.action.OPEN_APP"

  const val EXTRA_VAULT_ID = "com.ivyea.note.extra.VAULT_ID"
  const val EXTRA_PATH = "com.ivyea.note.extra.PATH"
  /**
   * 已经被领过一次的标记。同一个 Intent 对象可能被两条路各看一眼
   * （Activity 生命周期回调 + 插件 load），打上它就不会做两遍。
   */
  private const val EXTRA_CONSUMED = "com.ivyea.note.extra.CONSUMED"

  /** JS 侧 `kind` 的取值 */
  const val KIND_NEW = "new"
  const val KIND_DAILY = "daily"
  const val KIND_OPEN = "open"
  const val KIND_APP = "app"

  /** 一个待处理的动作（已经从 intent 上解析出来） */
  data class Action(val kind: String, val vaultId: Long, val path: String, val at: Long) {
    fun toJS(): JSObject {
      val o = JSObject()
      o.put("kind", kind)
      o.put("vaultId", vaultId)
      o.put("path", path)
      o.put("at", at)
      return o
    }
  }

  fun kindOf(action: String?): String? = when (action) {
    ACTION_NEW_NOTE -> KIND_NEW
    ACTION_DAILY -> KIND_DAILY
    ACTION_OPEN_NOTE -> KIND_OPEN
    ACTION_OPEN_APP -> KIND_APP
    else -> null
  }

  /**
   * 从 intent 上解析动作；不是我们的 intent、或已经领过、或是从最近任务里恢复的
   * （系统会把当初那个 intent 原样再投一遍，那时候不该再新建一篇笔记）都返回 null。
   * 解析成功即打上已领标记。
   */
  fun consume(intent: Intent?): Action? {
    if (intent == null) return null
    val kind = kindOf(intent.action) ?: return null
    if (intent.getBooleanExtra(EXTRA_CONSUMED, false)) return null
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null
    intent.putExtra(EXTRA_CONSUMED, true)
    return Action(
      kind,
      intent.getLongExtra(EXTRA_VAULT_ID, 0L),
      intent.getStringExtra(EXTRA_PATH) ?: "",
      System.currentTimeMillis()
    )
  }

  /**
   * 造一个会把应用拉起来（或切到前台）并携带动作的 intent。
   *
   * 以 `getLaunchIntentForPackage` 为底：它带着显式 component 和 NEW_TASK，
   * 与点桌面图标是同一条路，只是多了 action / extras。这里刻意不写死 Activity 类名——
   * MainActivity 由 tauri CLI 生成，名字不归我们管。
   */
  fun launch(context: Context, action: String, vaultId: Long = 0L, path: String = ""): Intent {
    val base = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
    val intent = Intent(base)
    intent.action = action
    // component 已显式，LAUNCHER 分类去掉：别让系统把它当成"点了桌面图标"那种特殊情况处理
    intent.removeCategory(Intent.CATEGORY_LAUNCHER)
    intent.replaceExtras(android.os.Bundle())
    if (vaultId != 0L) intent.putExtra(EXTRA_VAULT_ID, vaultId)
    if (path.isNotEmpty()) intent.putExtra(EXTRA_PATH, path)
    /*
     * data 只为了"区分"：PendingIntent 判等（filterEquals）不看 extras，两张卡片都是
     * OPEN_NOTE 而 path 不同时，没有 data 就可能拿到同一个 PendingIntent、点开同一篇。
     * 这个 URI 没人解析，Activity 那边只认 action + extras。
     */
    if (path.isNotEmpty()) intent.data = android.net.Uri.fromParts("ivnote", "$vaultId/$path", null)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return intent
  }
}
