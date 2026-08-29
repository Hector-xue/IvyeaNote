// MCP 层的单元测试。
//
// 服务端此前一个 Go 测试文件都没有，一致性靠 scripts/conformance.sh（要 Docker 起
// postgres + 服务容器）。那套跑的是同步协议；MCP 这层是新逻辑，检索排序、双链解析、
// JSON-RPC 分发都是纯计算，值得在没有数据库的情况下就钉死。
package api

import (
	"encoding/json"
	"testing"
)

func docs() []noteDoc {
	return []noteDoc{
		{Path: "广告优化.md", Content: "# 广告优化\n投放策略要看 ACOS 和转化率\n相关：[[关键词研究]]\n再提一次 ACOS\n"},
		{Path: "日记/2026-08-29.md", Content: "# 2026-08-29\n今天研究了 [[广告优化]]\n"},
		{Path: "关键词研究.md", Content: "# 关键词研究\nABA 反查竞品\n"},
		{Path: "无关.md", Content: "# 无关\n完全没有关系的内容\n"},
	}
}

// ---------- 检索 ----------

func TestSearchNotesMatchesContent(t *testing.T) {
	hits := searchNotes(docs(), "ACOS", 10)
	if len(hits) != 1 {
		t.Fatalf("想要 1 篇命中，得到 %d", len(hits))
	}
	if hits[0].Path != "广告优化.md" {
		t.Fatalf("命中了错的一篇：%s", hits[0].Path)
	}
	if len(hits[0].Lines) != 2 {
		t.Fatalf("想要 2 条命中行，得到 %d", len(hits[0].Lines))
	}
	if hits[0].Lines[0].Line != 2 {
		t.Fatalf("行号应当 1 起且指向第 2 行，得到 %d", hits[0].Lines[0].Line)
	}
}

func TestSearchNotesMatchesPath(t *testing.T) {
	// 路径也参与匹配：按文件名找是最常见的用法
	if hits := searchNotes(docs(), "日记", 10); len(hits) != 1 {
		t.Fatalf("按路径应命中 1 篇，得到 %d", len(hits))
	}
}

func TestSearchNotesMultiTermIsAnd(t *testing.T) {
	// 两个词都出现才算命中，否则搜索会变得毫无区分度
	if hits := searchNotes(docs(), "ACOS 转化率", 10); len(hits) != 1 {
		t.Fatalf("两词都命中应得 1 篇，得到 %d", len(hits))
	}
	if hits := searchNotes(docs(), "ACOS 不存在的词", 10); len(hits) != 0 {
		t.Fatalf("有一个词没命中就不该出结果，得到 %d", len(hits))
	}
}

func TestSearchNotesCaseInsensitive(t *testing.T) {
	if hits := searchNotes(docs(), "acos", 10); len(hits) != 1 {
		t.Fatalf("大小写不该影响命中，得到 %d", len(hits))
	}
}

func TestSearchNotesRanksByHitCount(t *testing.T) {
	ds := []noteDoc{
		{Path: "少.md", Content: "广告\n"},
		{Path: "多.md", Content: "广告\n广告\n广告\n"},
	}
	hits := searchNotes(ds, "广告", 10)
	if len(hits) != 2 || hits[0].Path != "多.md" {
		t.Fatalf("命中行多的该排前面，得到 %+v", hits)
	}
}

func TestSearchNotesStableOrderOnTie(t *testing.T) {
	// 同一个查询两次给出不同顺序，会让模型每轮看到的东西都在变
	ds := []noteDoc{{Path: "b.md", Content: "x\n"}, {Path: "a.md", Content: "x\n"}}
	for i := 0; i < 5; i++ {
		hits := searchNotes(ds, "x", 10)
		if hits[0].Path != "a.md" {
			t.Fatalf("同分应按路径稳定排序，得到 %s", hits[0].Path)
		}
	}
}

func TestSearchNotesLimit(t *testing.T) {
	ds := []noteDoc{}
	for i := 0; i < 30; i++ {
		ds = append(ds, noteDoc{Path: string(rune('a'+i%26)) + ".md", Content: "广告\n"})
	}
	if hits := searchNotes(ds, "广告", 5); len(hits) != 5 {
		t.Fatalf("limit 该生效，得到 %d", len(hits))
	}
}

func TestSearchNotesEmptyQuery(t *testing.T) {
	if hits := searchNotes(docs(), "   ", 10); len(hits) != 0 {
		t.Fatalf("空查询不该返回全库，得到 %d", len(hits))
	}
}

func TestSearchNotesCapsPreviewLines(t *testing.T) {
	ds := []noteDoc{{Path: "a.md", Content: "x\nx\nx\nx\nx\nx\n"}}
	if n := len(searchNotes(ds, "x", 10)[0].Lines); n != 3 {
		t.Fatalf("命中行预览最多 3 条，得到 %d", n)
	}
}

// ---------- 双链 ----------

func TestExtractLinks(t *testing.T) {
	got := extractLinks("见 [[广告优化]] 与 [[关键词研究|别名]]，还有 [普通链接](http://x)")
	if len(got) != 2 || got[0] != "广告优化" || got[1] != "关键词研究" {
		t.Fatalf("双链解析错了：%v", got)
	}
}

func TestExtractLinksIgnoresUnclosed(t *testing.T) {
	if got := extractLinks("残缺的 [[没有闭合"); len(got) != 0 {
		t.Fatalf("没闭合的不该算：%v", got)
	}
}

func TestTitleOfPath(t *testing.T) {
	cases := map[string]string{
		"广告优化.md":            "广告优化",
		"日记/2026-08-29.md":   "2026-08-29",
		"a/b/c.markdown":     "c",
		"没有扩展名":              "没有扩展名",
	}
	for in, want := range cases {
		if got := titleOfPath(in); got != want {
			t.Fatalf("titleOfPath(%q)=%q，想要 %q", in, got, want)
		}
	}
}

func TestBacklinks(t *testing.T) {
	in, out := backlinks(docs(), "广告优化.md")
	if len(in) != 1 || in[0] != "日记/2026-08-29.md" {
		t.Fatalf("入链错了：%v", in)
	}
	if len(out) != 1 || out[0] != "关键词研究" {
		t.Fatalf("出链错了：%v", out)
	}
}

func TestBacklinksExcludesSelf(t *testing.T) {
	// 一篇笔记里写了指向自己的链接时，不该把自己算成自己的入链
	ds := []noteDoc{{Path: "a.md", Content: "[[a]]\n"}}
	in, out := backlinks(ds, "a.md")
	if len(in) != 0 {
		t.Fatalf("自己不该是自己的入链：%v", in)
	}
	if len(out) != 1 {
		t.Fatalf("出链应保留：%v", out)
	}
}

func TestBacklinksNeverNil(t *testing.T) {
	// 返回 nil 会在 JSON 里变成 null，让消费方多一种要判的情况
	in, out := backlinks(nil, "x.md")
	if in == nil || out == nil {
		t.Fatalf("空结果也该是空切片而不是 nil：%v %v", in, out)
	}
}

// ---------- JSON-RPC 分发 ----------

func TestDispatchInitialize(t *testing.T) {
	s := &Server{}
	res, err := s.mcpDispatch(t.Context(), 1, rpcReq{Method: "initialize", ID: json.RawMessage(`1`)})
	if err != nil {
		t.Fatalf("initialize 不该出错：%v", err)
	}
	m := res.(map[string]any)
	if m["protocolVersion"] != mcpProtocolVersion {
		t.Fatalf("协议版本要与 agent 的 initialize 请求一致，得到 %v", m["protocolVersion"])
	}
	if _, ok := m["serverInfo"]; !ok {
		t.Fatal("缺少 serverInfo")
	}
}

func TestDispatchToolsList(t *testing.T) {
	s := &Server{}
	res, rerr := s.mcpDispatch(t.Context(), 1, rpcReq{Method: "tools/list", ID: json.RawMessage(`1`)})
	if rerr != nil {
		t.Fatalf("tools/list 不该出错：%v", rerr)
	}
	tools := res.(map[string]any)["tools"].([]mcpTool)
	want := map[string]bool{"notes_list": false, "notes_read": false, "notes_search": false, "notes_backlinks": false}
	for _, tl := range tools {
		if _, ok := want[tl.Name]; !ok {
			t.Fatalf("多了个没预期的工具：%s", tl.Name)
		}
		want[tl.Name] = true
		if tl.Description == "" {
			t.Fatalf("%s 没有描述——模型是靠描述决定用不用它的", tl.Name)
		}
		if tl.InputSchema == nil {
			t.Fatalf("%s 没有 inputSchema", tl.Name)
		}
	}
	for name, seen := range want {
		if !seen {
			t.Fatalf("方案 §6.1 点名的 %s 没有暴露", name)
		}
	}
}

func TestToolsListShapeMatchesAgentExpectation(t *testing.T) {
	// agent 侧是 (res or {}).get("tools", [])，所以顶层必须是 {"tools":[...]}，
	// 且每个工具序列化后的键名必须是 name / description / inputSchema
	s := &Server{}
	res, _ := s.mcpDispatch(t.Context(), 1, rpcReq{Method: "tools/list", ID: json.RawMessage(`1`)})
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Tools []map[string]json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Tools) == 0 {
		t.Fatal("tools 为空")
	}
	for _, tl := range parsed.Tools {
		for _, k := range []string{"name", "description", "inputSchema"} {
			if _, ok := tl[k]; !ok {
				t.Fatalf("工具缺少字段 %s", k)
			}
		}
	}
}

func TestDispatchUnknownMethod(t *testing.T) {
	s := &Server{}
	_, rerr := s.mcpDispatch(t.Context(), 1, rpcReq{Method: "不存在的方法", ID: json.RawMessage(`1`)})
	if rerr == nil || rerr.Code != -32601 {
		t.Fatalf("未知方法该回 -32601，得到 %v", rerr)
	}
}

func TestDispatchEmptyListsForResourcesAndPrompts(t *testing.T) {
	// agent 启动时会依次问 resources/list 与 prompts/list。回 -32601 会让它记一次错误；
	// 我们没有这两类，就明确回空表。
	s := &Server{}
	for _, m := range []string{"resources/list", "prompts/list"} {
		if _, rerr := s.mcpDispatch(t.Context(), 1, rpcReq{Method: m, ID: json.RawMessage(`1`)}); rerr != nil {
			t.Fatalf("%s 该回空表而不是报错：%v", m, rerr)
		}
	}
}

// ---------- 令牌 ----------

func TestHashTokenIsStableAndTrims(t *testing.T) {
	a := hashToken("ivnote_mcp_abc")
	if a != hashToken("  ivnote_mcp_abc  ") {
		t.Fatal("前后空白应被忽略——复制粘贴很容易带上")
	}
	if len(a) != 64 {
		t.Fatalf("应是 sha256 十六进制（64 位），得到 %d", len(a))
	}
	if a == hashToken("ivnote_mcp_abd") {
		t.Fatal("不同令牌不该撞哈希")
	}
}

func TestNewMCPTokenShape(t *testing.T) {
	a, err := newMCPToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newMCPToken()
	if a == b {
		t.Fatal("两次签发不该相同")
	}
	if len(a) < 32 {
		t.Fatalf("令牌太短：%d", len(a))
	}
	if a[:11] != "ivnote_mcp_" {
		t.Fatalf("前缀便于日后在日志/仓库扫描里揪出误提交，得到 %q", a[:11])
	}
}

// ---------- 参数解析 ----------

func TestArgHelpers(t *testing.T) {
	args := map[string]any{"path": "  a.md  ", "vault_id": float64(7), "bad": 1}
	if got := argStr(args, "path"); got != "a.md" {
		t.Fatalf("argStr 该去空白，得到 %q", got)
	}
	if got := argStr(args, "missing"); got != "" {
		t.Fatalf("缺字段该给空串，得到 %q", got)
	}
	// JSON 数字进来是 float64，直接断言 int64 会永远拿到 0
	if got := argInt(args, "vault_id"); got != 7 {
		t.Fatalf("argInt 该认 float64，得到 %d", got)
	}
	if got := argInt(args, "missing"); got != 0 {
		t.Fatalf("缺字段该给 0，得到 %d", got)
	}
}
