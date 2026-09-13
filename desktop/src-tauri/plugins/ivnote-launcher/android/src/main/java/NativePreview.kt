package com.ivyea.note.launcher

import android.content.Context

/**
 * 配置页刚绑好一篇、JS 还没推快照时，原生先自己读一遍文件画个预览——
 * 只对库在磁盘上（SAF / 绝对路径）的情况有效，OPFS 读不到就算了（卡片显示"点一下打开"，
 * App 下次起来会推真正的快照）。
 *
 * 剥记号的规则是 JS 侧 lib/widgetText.ts 的简化版：只求"看着像那篇笔记"，
 * JS 推来的快照会覆盖这里的结果。
 */
object NativePreview {
  private const val MAX = 1200

  fun snapshot(context: Context, root: String, vaultId: Long, path: String): WidgetStore.Snapshot? {
    if (root.isEmpty() || root.startsWith("opfs://")) return null
    val text = try {
      TodoWriter.readText(context, root, path) ?: return null
    } catch (ex: Exception) {
      return null
    }
    val title = path.substringAfterLast('/').replace(Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE), "")
    return WidgetStore.Snapshot(vaultId, path, title, strip(text), System.currentTimeMillis())
  }

  fun strip(markdown: String): String {
    var text = markdown.replace("\r\n", "\n").replace('\r', '\n')
    text = text.replace(Regex("^---\\n[\\s\\S]*?\\n---\\n?"), "")
    text = text.replace(Regex("(?m)^\\s*(```|~~~)[^\\n]*$"), "")
    val out = ArrayList<String>()
    for (raw in text.split('\n')) {
      var line = raw
      line = line.replace(Regex("!\\[[^\\]]*\\]\\([^)]*\\)"), "")
      line = line.replace(Regex("^(\\s*)[-*+]\\s+\\[[xX]\\]\\s*"), "$1☑ ")
      line = line.replace(Regex("^(\\s*)[-*+]\\s+\\[\\s\\]\\s*"), "$1☐ ")
      line = line.replace(Regex("^(\\s*)[-*+]\\s+"), "$1• ")
      line = line.replace(Regex("^\\s*#{1,6}\\s+"), "")
      line = line.replace(Regex("^\\s*>\\s?"), "")
      line = line.replace(Regex("\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]")) { m ->
        m.groupValues[2].ifEmpty { m.groupValues[1].substringAfterLast('/').replace(Regex("\\.(md|markdown)$", RegexOption.IGNORE_CASE), "") }
      }
      line = line.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
      line = line.replace(Regex("(\\*\\*|__)(.+?)\\1"), "$2")
      line = line.replace(Regex("~~(.+?)~~"), "$1")
      line = line.replace(Regex("==(.+?)=="), "$1")
      line = line.replace(Regex("`([^`]+)`"), "$1")
      line = line.replace(Regex("<[^>]+>"), "")
      if (Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$").matches(line)) line = ""
      out.add(line.trimEnd())
    }
    val collapsed = out.joinToString("\n").replace(Regex("\\n{3,}"), "\n\n").trim('\n')
    return if (collapsed.length <= MAX) collapsed else collapsed.substring(0, MAX - 1) + "…"
  }
}
