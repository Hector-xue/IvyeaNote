package com.ivyea.note.saf

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class TreeArg {
  lateinit var tree: String
}

@InvokeArg
class PathArg {
  lateinit var tree: String
  lateinit var path: String
}

@InvokeArg
class WriteTextArg {
  lateinit var tree: String
  lateinit var path: String
  lateinit var content: String
}

@InvokeArg
class WriteBinaryArg {
  lateinit var tree: String
  lateinit var path: String
  lateinit var base64: String
}

/** 树内一个条目的解析结果 */
private data class Node(
  val documentId: String,
  val isDir: Boolean,
  val mtime: Long,
  val size: Long,
)

/**
 * SAF 桥。
 *
 * ## 为什么要缓存
 *
 * SAF 里没有"按路径打开"这回事：拿到的是一棵树的根 documentId，要找 `a/b/c.md`
 * 必须一层层 query 子节点。每次 query 都是一次跨进程 ContentResolver 调用——
 * 同步引擎动辄对几百个文件做 exists/read，逐个走树会慢到完全不可用。
 *
 * 所以这里维护 `树URI -> (相对路径 -> Node)` 的缓存：`listEntries` 一次 BFS 把整棵树
 * 读进来（每个目录一个 cursor，而不是每个文件一次查询），之后的读写直接查表。
 * 写入/删除会就地更新缓存，不整棵作废——否则每存一次笔记就要重新遍历全库。
 */
@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {

  private val cache = HashMap<String, HashMap<String, Node>>()

  // ---------------------------------------------------------------- 选目录

  @Command
  fun pickVaultFolder(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      intent.addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      )
      startActivityForResult(invoke, intent, "pickVaultFolderResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "无法打开目录选择器")
    }
  }

  @ActivityCallback
  fun pickVaultFolderResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.reject("已取消")
      return
    }
    val uri = result.data?.data
    if (uri == null) {
      invoke.reject("没有拿到目录")
      return
    }
    try {
      // 必须持久化授权：否则应用一重启，这个 URI 就再也读不了了——
      // 表现就是"昨天还好好的，今天打开笔记全没了"
      activity.contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      )
      val res = JSObject()
      res.put("uri", uri.toString())
      res.put("name", displayNameOfTree(uri))
      cache.remove(uri.toString())
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "无法获得该目录的长期访问权限")
    }
  }

  /** 目录树的显示名，给界面上"存在哪儿"用；取不到就退回 URI 末段 */
  private fun displayNameOfTree(tree: Uri): String {
    val docId = DocumentsContract.getTreeDocumentId(tree)
    val docUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    activity.contentResolver.query(
      docUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
    )?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
    }
    return docId.substringAfterLast(':').ifEmpty { tree.lastPathSegment ?: "已选目录" }
  }

  // ---------------------------------------------------------------- 遍历

  @Command
  fun listEntries(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TreeArg::class.java)
      val map = buildIndex(args.tree)
      val arr = JSArray()
      for ((path, node) in map) {
        if (node.isDir) continue
        val o = JSObject()
        o.put("path", path)
        o.put("mtime", node.mtime)
        o.put("size", node.size)
        arr.put(o)
      }
      val res = JSObject()
      res.put("entries", arr)
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "读取目录失败")
    }
  }

  /** 整棵树扫一遍，建立 相对路径 -> Node。每个目录一个 cursor。 */
  private fun buildIndex(tree: String): HashMap<String, Node> {
    val treeUri = Uri.parse(tree)
    val rootId = DocumentsContract.getTreeDocumentId(treeUri)
    val out = HashMap<String, Node>()
    // (documentId, 相对路径前缀)
    val queue = ArrayDeque<Pair<String, String>>()
    queue.add(Pair(rootId, ""))
    val projection = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
      DocumentsContract.Document.COLUMN_SIZE,
    )
    while (queue.isNotEmpty()) {
      val (parentId, prefix) = queue.removeFirst()
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
      activity.contentResolver.query(childrenUri, projection, null, null, null)?.use { c ->
        while (c.moveToNext()) {
          val id = c.getString(0)
          val name = c.getString(1) ?: continue
          val mime = c.getString(2)
          val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
          val mtime = if (c.isNull(3)) 0L else c.getLong(3)
          val size = if (c.isNull(4)) 0L else c.getLong(4)
          val rel = if (prefix.isEmpty()) name else "$prefix/$name"
          out[rel] = Node(id, isDir, mtime, size)
          if (isDir) queue.add(Pair(id, rel))
        }
      }
    }
    cache[tree] = out
    return out
  }

  /** 拿缓存；没有就建一次。 */
  private fun index(tree: String): HashMap<String, Node> = cache[tree] ?: buildIndex(tree)

  private fun nodeOf(tree: String, path: String): Node? {
    val cached = index(tree)[path]
    if (cached != null) return cached
    // 缓存里没有：可能是别的应用刚刚写进来的，重扫一次再判定
    return buildIndex(tree)[path]
  }

  private fun docUri(tree: String, node: Node): Uri =
    DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), node.documentId)

  // ---------------------------------------------------------------- 读

  @Command
  fun readText(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PathArg::class.java)
      val node = nodeOf(args.tree, args.path) ?: throw Exception("文件不存在：${args.path}")
      val bytes = activity.contentResolver.openInputStream(docUri(args.tree, node))?.use {
        it.readBytes()
      } ?: throw Exception("无法读取：${args.path}")
      val res = JSObject()
      res.put("content", String(bytes, Charsets.UTF_8))
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "读取失败")
    }
  }

  @Command
  fun readBinary(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PathArg::class.java)
      val node = nodeOf(args.tree, args.path) ?: throw Exception("文件不存在：${args.path}")
      val bytes = activity.contentResolver.openInputStream(docUri(args.tree, node))?.use {
        it.readBytes()
      } ?: throw Exception("无法读取：${args.path}")
      val res = JSObject()
      res.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "读取失败")
    }
  }

  @Command
  fun entryExists(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PathArg::class.java)
      val res = JSObject()
      res.put("value", nodeOf(args.tree, args.path) != null)
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "判断失败")
    }
  }

  // ---------------------------------------------------------------- 写

  @Command
  fun writeText(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WriteTextArg::class.java)
      writeBytes(args.tree, args.path, args.content.toByteArray(Charsets.UTF_8))
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "写入失败")
    }
  }

  @Command
  fun writeBinary(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WriteBinaryArg::class.java)
      writeBytes(args.tree, args.path, Base64.decode(args.base64, Base64.DEFAULT))
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "写入失败")
    }
  }

  /**
   * 写文件；父目录不存在就逐级建出来。
   *
   * 已存在时**截断重写**而不是删了重建：删除会让 documentId 变化，缓存里所有指向它的
   * 引用一起失效，而且别的应用可能正拿着这个 URI。`"wt"` 模式就是截断。
   */
  private fun writeBytes(tree: String, path: String, bytes: ByteArray) {
    val existing = nodeOf(tree, path)
    val uri = if (existing != null && !existing.isDir) {
      docUri(tree, existing)
    } else {
      val slash = path.lastIndexOf('/')
      val dirPath = if (slash < 0) "" else path.substring(0, slash)
      val name = if (slash < 0) path else path.substring(slash + 1)
      val parentId = ensureDir(tree, dirPath)
      val created = DocumentsContract.createDocument(
        activity.contentResolver,
        DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), parentId),
        mimeOf(name),
        name
      ) ?: throw Exception("无法创建文件：$path")
      created
    }
    activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
      ?: throw Exception("无法写入：$path")

    // 就地更新缓存，别把整棵树作废——否则每存一次笔记都要重新遍历全库
    val id = DocumentsContract.getDocumentId(uri)
    index(tree)[path] = Node(id, false, System.currentTimeMillis(), bytes.size.toLong())
  }

  /** 确保目录存在，返回它的 documentId。空路径＝树根。 */
  private fun ensureDir(tree: String, dirPath: String): String {
    val treeUri = Uri.parse(tree)
    var parentId = DocumentsContract.getTreeDocumentId(treeUri)
    if (dirPath.isEmpty()) return parentId
    val map = index(tree)
    var built = ""
    for (seg in dirPath.split('/')) {
      if (seg.isEmpty()) continue
      built = if (built.isEmpty()) seg else "$built/$seg"
      val hit = map[built]
      parentId = if (hit != null && hit.isDir) {
        hit.documentId
      } else {
        val created = DocumentsContract.createDocument(
          activity.contentResolver,
          DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId),
          DocumentsContract.Document.MIME_TYPE_DIR,
          seg
        ) ?: throw Exception("无法创建文件夹：$built")
        val id = DocumentsContract.getDocumentId(created)
        map[built] = Node(id, true, System.currentTimeMillis(), 0)
        id
      }
    }
    return parentId
  }

  @Command
  fun removeEntry(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PathArg::class.java)
      val node = nodeOf(args.tree, args.path)
      if (node != null) {
        DocumentsContract.deleteDocument(activity.contentResolver, docUri(args.tree, node))
        val map = index(args.tree)
        map.remove(args.path)
        // 删目录时把它底下的条目一起从缓存摘掉
        if (node.isDir) {
          val prefix = args.path + "/"
          map.keys.filter { it.startsWith(prefix) }.forEach { map.remove(it) }
        }
      }
      invoke.resolve(JSObject())
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "删除失败")
    }
  }

  /** 按后缀给 MIME。给错会让系统文件管理器把 .md 显示成未知类型，但不影响读写。 */
  private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "md", "markdown", "txt" -> "text/plain"
    "png" -> "image/png"
    "jpg", "jpeg" -> "image/jpeg"
    "gif" -> "image/gif"
    "webp" -> "image/webp"
    "pdf" -> "application/pdf"
    else -> "application/octet-stream"
  }
}
