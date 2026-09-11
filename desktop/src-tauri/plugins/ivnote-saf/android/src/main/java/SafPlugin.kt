package com.ivyea.note.saf

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

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
 *
 * ## 为什么不在主线程干活（v0.11.27）
 *
 * Tauri 的安卓插件命令是在**主线程**上被调用的（`run_on_android_context`）。
 * 整树 BFS、跨进程 query、文件读写全压在 UI 线程上，迁移几十篇笔记的那几秒里整个
 * 界面纹丝不动——2026-09-12 用户报的「特别卡、按钮没反应」就是这个。
 * 现在所有磁盘活都排到 [worker]（单线程，保持命令的先后顺序）上跑，主线程只负责
 * 收命令、起系统目录选择器；`Invoke.resolve/reject` 本身允许在任意线程调用。
 * 缓存只在 worker 线程上读写，所以不用加锁。
 */
private const val PREFS = "ivnote-saf"
private const val KEY_PENDING_URI = "pending_uri"
private const val KEY_PENDING_NAME = "pending_name"
private const val KEY_PENDING_AT = "pending_at"

/** 没有更好的答案时给系统的 MIME；ExternalStorageProvider 对它**不改名**（见 mimeOf） */
private const val MIME_UNKNOWN = "application/octet-stream"

@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {

  private val cache = HashMap<String, HashMap<String, Node>>()

  /** 所有 ContentResolver 读写都排在这一条线程上（见类注释） */
  private val worker = Executors.newSingleThreadExecutor { r ->
    Thread(r, "ivnote-saf").also { it.isDaemon = true }
  }

  /**
   * 把一条命令挪到 worker 上执行：body 算出结果就 resolve，抛异常就 reject。
   * `fallback` 是异常没带消息时给前端看的那句话，和以前各命令里写死的一样。
   */
  private fun onWorker(invoke: Invoke, fallback: String, body: () -> JSObject) {
    worker.execute {
      val res = try {
        body()
      } catch (ex: Exception) {
        invoke.reject(ex.message ?: fallback)
        return@execute
      }
      invoke.resolve(res)
    }
  }

  private val projection = arrayOf(
    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    DocumentsContract.Document.COLUMN_SIZE,
  )

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
      val name = displayNameOfTree(uri)
      /*
       * v0.11.26：结果同时落到 SharedPreferences。
       *
       * 系统目录选择器是另一个 Activity；选完回来时，主 Activity 可能已经被系统回收重建
       * （内存紧、开发者选项"不保留活动"），WebView 一重载，JS 那边等着这个结果的 Promise
       * 就没了——表现是"选完文件夹什么反应都没有"。这里先把结果存下来，JS 启动时再用
       * takePendingPick 把它领走，把没走完的流程接着走完。
       */
      activity.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit()
        .putString(KEY_PENDING_URI, uri.toString())
        .putString(KEY_PENDING_NAME, name)
        .putLong(KEY_PENDING_AT, System.currentTimeMillis())
        .apply()
      val res = JSObject()
      res.put("uri", uri.toString())
      res.put("name", name)
      // 缓存只在 worker 线程上碰（见类注释），这里也排过去
      val key = uri.toString()
      worker.execute { cache.remove(key) }
      invoke.resolve(res)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "无法获得该目录的长期访问权限")
    }
  }

  /**
   * 领走上一次选目录的结果（领走即清空）。没有就 `uri` 为空串。
   * 只在 JS 侧还记着"我发起过一次选目录、但没等到结果"时才有意义（见 App.tsx 的 pendingPick）。
   */
  @Command
  fun takePendingPick(invoke: Invoke) {
    val prefs = activity.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
    val uri = prefs.getString(KEY_PENDING_URI, null)
    val name = prefs.getString(KEY_PENDING_NAME, null)
    val at = prefs.getLong(KEY_PENDING_AT, 0L)
    prefs.edit().remove(KEY_PENDING_URI).remove(KEY_PENDING_NAME).remove(KEY_PENDING_AT).apply()
    val res = JSObject()
    res.put("uri", uri ?: "")
    res.put("name", name ?: "")
    res.put("at", at)
    invoke.resolve(res)
  }

  /** 目录树的显示名，给界面上"存在哪儿"用；取不到就退回 URI 末段 */
  private fun displayNameOfTree(tree: Uri): String {
    val docId = DocumentsContract.getTreeDocumentId(tree)
    val docUri = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    displayNameOf(docUri)?.let { return it }
    return docId.substringAfterLast(':').ifEmpty { tree.lastPathSegment ?: "已选目录" }
  }

  /** 某个文档在提供方那里的显示名；查不到就 null */
  private fun displayNameOf(doc: Uri): String? {
    activity.contentResolver.query(
      doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null
    )?.use { c ->
      if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
    }
    return null
  }

  // ---------------------------------------------------------------- 遍历

  @Command
  fun listEntries(invoke: Invoke) {
    onWorker(invoke, "读取目录失败") {
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
      res
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
    while (queue.isNotEmpty()) {
      val (parentId, prefix) = queue.removeFirst()
      for ((name, node) in queryChildren(treeUri, parentId)) {
        val rel = if (prefix.isEmpty()) name else "$prefix/$name"
        out[rel] = node
        if (node.isDir) queue.add(Pair(node.documentId, rel))
      }
    }
    cache[tree] = out
    return out
  }

  /** 一个目录的直接子项：显示名 -> Node。一次 cursor。 */
  private fun queryChildren(treeUri: Uri, parentId: String): List<Pair<String, Node>> {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
    val out = ArrayList<Pair<String, Node>>()
    activity.contentResolver.query(childrenUri, projection, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        val name = c.getString(1) ?: continue
        val mime = c.getString(2)
        val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
        val mtime = if (c.isNull(3)) 0L else c.getLong(3)
        val size = if (c.isNull(4)) 0L else c.getLong(4)
        out.add(Pair(name, Node(id, isDir, mtime, size)))
      }
    }
    return out
  }

  /** 拿缓存；没有就建一次。 */
  private fun index(tree: String): HashMap<String, Node> = cache[tree] ?: buildIndex(tree)

  /**
   * 按相对路径定位一个条目。
   *
   * 缓存命中直接返回；未命中**只沿着这条路径逐级查**（每层一个 cursor），顺手把沿途
   * 目录的子项也填进缓存。v0.11.26 及之前这里未命中就整棵树重扫：同步引擎对每个
   * 还不存在的文件 exists/write 一次，就重扫一次全库——迁移 30 篇笔记要扫 30 遍树，
   * 而且全在主线程上。
   *
   * 逐级查而不是"缓存里没有就当没有"，是为了别的应用刚写进来的文件也能被看见。
   */
  private fun nodeOf(tree: String, path: String): Node? {
    val map = index(tree)
    map[path]?.let { return it }
    val segs = path.split('/').filter { it.isNotEmpty() }
    if (segs.isEmpty()) return null
    val treeUri = Uri.parse(tree)
    var parentId = DocumentsContract.getTreeDocumentId(treeUri)
    var prefix = ""
    var found: Node? = null
    for ((i, seg) in segs.withIndex()) {
      val built = if (prefix.isEmpty()) seg else "$prefix/$seg"
      val cached = map[built]
      if (cached != null) {
        found = cached
      } else {
        var hit: Node? = null
        for ((name, node) in queryChildren(treeUri, parentId)) {
          map[if (prefix.isEmpty()) name else "$prefix/$name"] = node
          if (name == seg) hit = node
        }
        found = hit ?: return null
      }
      // 中间段必须是目录，否则这条路径不存在
      if (i < segs.lastIndex && !found.isDir) return null
      parentId = found.documentId
      prefix = built
    }
    return found
  }

  private fun docUri(tree: String, node: Node): Uri =
    DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), node.documentId)

  // ---------------------------------------------------------------- 读

  @Command
  fun readText(invoke: Invoke) {
    onWorker(invoke, "读取失败") {
      val args = invoke.parseArgs(PathArg::class.java)
      val res = JSObject()
      res.put("content", String(readAll(args.tree, args.path), Charsets.UTF_8))
      res
    }
  }

  @Command
  fun readBinary(invoke: Invoke) {
    onWorker(invoke, "读取失败") {
      val args = invoke.parseArgs(PathArg::class.java)
      val res = JSObject()
      res.put("base64", Base64.encodeToString(readAll(args.tree, args.path), Base64.NO_WRAP))
      res
    }
  }

  private fun readAll(tree: String, path: String): ByteArray {
    val node = nodeOf(tree, path) ?: throw Exception("文件不存在：$path")
    return activity.contentResolver.openInputStream(docUri(tree, node))?.use { it.readBytes() }
      ?: throw Exception("无法读取：$path")
  }

  @Command
  fun entryExists(invoke: Invoke) {
    onWorker(invoke, "判断失败") {
      val args = invoke.parseArgs(PathArg::class.java)
      val res = JSObject()
      res.put("value", nodeOf(args.tree, args.path) != null)
      res
    }
  }

  // ---------------------------------------------------------------- 写

  @Command
  fun writeText(invoke: Invoke) {
    onWorker(invoke, "写入失败") {
      val args = invoke.parseArgs(WriteTextArg::class.java)
      writeBytes(args.tree, args.path, args.content.toByteArray(Charsets.UTF_8))
      JSObject()
    }
  }

  @Command
  fun writeBinary(invoke: Invoke) {
    onWorker(invoke, "写入失败") {
      val args = invoke.parseArgs(WriteBinaryArg::class.java)
      writeBytes(args.tree, args.path, Base64.decode(args.base64, Base64.DEFAULT))
      JSObject()
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
      createChecked(
        DocumentsContract.buildDocumentUriUsingTree(Uri.parse(tree), parentId),
        mimeOf(name),
        name,
        path
      )
    }
    activity.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
      ?: throw Exception("无法写入：$path")

    // 就地更新缓存，别把整棵树作废——否则每存一次笔记都要重新遍历全库
    val id = DocumentsContract.getDocumentId(uri)
    index(tree)[path] = Node(id, false, System.currentTimeMillis(), bytes.size.toLong())
  }

  /**
   * 建文件/目录，并**核对系统真正落下的名字**。
   *
   * `createDocument` 只是"请求"这个名字：ExternalStorageProvider 遇到同名会自动改成
   * `x (1)`，MIME 与后缀对不上会再补一个后缀（见 mimeOf）。v0.11.26 及之前这里
   * 拿到什么就往缓存里记成请求的那个路径——磁盘上是 `CNC.md.txt`，缓存说是 `CNC.md`，
   * 下一次重扫之后缓存对不上，再写一次就再建一份 `CNC.md (1).txt`……每同步一轮多一份，
   * 还全被当新文件推上云端（2026-09-12 事故）。
   *
   * 现在名字不一致就把刚建的空文件删掉、报错。宁可这一次写失败让人看见，也不能让
   * 磁盘和缓存各说各话。
   */
  private fun createChecked(parentUri: Uri, mime: String, name: String, path: String): Uri {
    val created = DocumentsContract.createDocument(activity.contentResolver, parentUri, mime, name)
      ?: throw Exception("无法创建：$path")
    val actual = displayNameOf(created)
    if (actual != null && actual != name) {
      try {
        DocumentsContract.deleteDocument(activity.contentResolver, created)
      } catch (ignored: Exception) {
        // 删不掉也只是多一个空文件；下面的报错才是要紧的
      }
      throw Exception("系统把「$name」落成了「$actual」，已放弃写入：$path")
    }
    return created
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
      val hit = nodeOf(tree, built)
      parentId = if (hit != null && hit.isDir) {
        hit.documentId
      } else {
        val created = createChecked(
          DocumentsContract.buildDocumentUriUsingTree(treeUri, parentId),
          DocumentsContract.Document.MIME_TYPE_DIR,
          seg,
          built
        )
        val id = DocumentsContract.getDocumentId(created)
        map[built] = Node(id, true, System.currentTimeMillis(), 0)
        id
      }
    }
    return parentId
  }

  @Command
  fun removeEntry(invoke: Invoke) {
    onWorker(invoke, "删除失败") {
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
      JSObject()
    }
  }

  /**
   * 给 `createDocument` 的 MIME。**这个值决定系统会不会改我们的文件名。**
   *
   * ExternalStorageProvider 建文件时（`FileUtils.buildUniqueFile` → `splitFileName`）会拿
   * 请求名的后缀去 `MimeTypeMap` 反查 MIME，和我们传的比：对得上就照原名建；对不上就
   * 把整个请求名当基名、再补上 MIME 对应的后缀。v0.11.26 及之前 `.md` 传的是
   * `text/plain`，后缀 `md` 反查不是它，于是 `CNC.md` 落盘成 `CNC.md.txt`。
   *
   * 所以：后缀在这台机器的 `MimeTypeMap` 里查得到就传查到的那个（必然对得上）；
   * 查不到就传 `application/octet-stream`——`splitFileName` 对这个值**不补后缀**
   * （`extFromMimeType` 为 null），名字原样落盘。两条路都不会改名。
   */
  private fun mimeOf(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    if (ext.isEmpty()) return MIME_UNKNOWN
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: MIME_UNKNOWN
  }
}
