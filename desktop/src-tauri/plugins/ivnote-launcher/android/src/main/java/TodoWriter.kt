package com.ivyea.note.launcher

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

/**
 * App 没在跑时，原生自己把 `- [ ]` 改成 `- [x]`。
 *
 * 只处理"文件就在磁盘上"的两种库：SAF 树（`content://…`，用装库时拿到的持久授权）和
 * 绝对路径。`opfs://` 是 WebView 私有存储，原生看不见，返回 [Result.UNSUPPORTED]，
 * 由调用方排队等 App 起来处理。
 *
 * 改之前核对那一行：行号上的那行必须还是同一条未完成事项（同步 / 别的设备可能已经改过），
 * 对不上就在全文里找**唯一**一条同文本的未完成事项；找不到或不唯一都不动文件（[Result.MISMATCH]），
 * 宁可让 App 起来后再判断，也不能改错行。
 * 匹配规则与 JS 侧 lib/todoTasks.ts 的 toggleTaskLine 一致。
 */
object TodoWriter {
  enum class Result { OK, UNSUPPORTED, MISMATCH, FAILED }

  private val TASK = Regex("""^(\s*(?:[-*+]|\d+[.)])\s+)\[ \]\s+(.*?)\s*$""")

  fun toggle(context: Context, root: String, path: String, line: Int, raw: String): Result {
    if (root.isEmpty() || root.startsWith("opfs://")) return Result.UNSUPPORTED
    return try {
      val bytes = read(context, root, path) ?: return Result.FAILED
      val content = String(bytes, Charsets.UTF_8)
      val next = toggleLine(content, line, raw) ?: return Result.MISMATCH
      write(context, root, path, next.toByteArray(Charsets.UTF_8))
      Result.OK
    } catch (ex: Exception) {
      Result.FAILED
    }
  }

  /** 纯函数：把第 [line] 行（或全文唯一一条同文本的）未完成事项标成完成；对不上返回 null */
  fun toggleLine(content: String, line: Int, raw: String): String? {
    val crlf = content.contains("\r\n")
    val lines = content.split("\n").map { it.removeSuffix("\r") }.toMutableList()
    fun matches(i: Int): Boolean {
      val m = TASK.find(lines[i]) ?: return false
      return m.groupValues[2] == raw
    }
    var idx = -1
    if (line in lines.indices && matches(line)) {
      idx = line
    } else {
      val hits = lines.indices.filter { matches(it) }
      if (hits.size == 1) idx = hits[0]
    }
    if (idx < 0) return null
    lines[idx] = lines[idx].replaceFirst("[ ]", "[x]")
    return lines.joinToString(if (crlf) "\r\n" else "\n")
  }

  // ---------------------------------------------------------------- 读写

  private fun read(context: Context, root: String, path: String): ByteArray? {
    if (root.startsWith("content://")) {
      val uri = resolve(context, root, path) ?: return null
      return context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
    }
    val f = File(root, path)
    return if (f.isFile) f.readBytes() else null
  }

  private fun write(context: Context, root: String, path: String, bytes: ByteArray) {
    if (root.startsWith("content://")) {
      val uri = resolve(context, root, path) ?: throw IllegalStateException("not found: $path")
      // "wt" = 截断重写；别删了重建（documentId 会变，App 里的缓存全作废）
      context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
        ?: throw IllegalStateException("cannot open: $path")
      return
    }
    File(root, path).writeBytes(bytes)
  }

  /** 沿路径逐级找子项（每层一个 cursor）。只找已存在的，不建 */
  private fun resolve(context: Context, tree: String, path: String): Uri? {
    val treeUri = Uri.parse(tree)
    var parentId = DocumentsContract.getTreeDocumentId(treeUri)
    val segs = path.split('/').filter { it.isNotEmpty() }
    if (segs.isEmpty()) return null
    for ((i, seg) in segs.withIndex()) {
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
      var hitId: String? = null
      var hitDir = false
      context.contentResolver.query(
        childrenUri,
        arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE),
        null, null, null
      )?.use { c ->
        while (c.moveToNext()) {
          if (c.getString(1) == seg) {
            hitId = c.getString(0)
            hitDir = c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
            break
          }
        }
      }
      val id = hitId ?: return null
      if (i < segs.lastIndex && !hitDir) return null
      parentId = id
    }
    return DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId)
  }
}
