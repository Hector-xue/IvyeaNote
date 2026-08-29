// MCP endpoint（P3 Agent 融合，方案 §6.1）。
//
// 为什么把 MCP 放在**同步服务端**而不是做个读 vault 目录的本地进程：
// 服务器上根本没有 .md 目录——笔记是内容寻址的 blob + heads 版本指针。而 agent
// 就跑在这台服务器上。挂在这里，agent 读到的与手机/桌面看到的是同一份真相，
// 写进去的也会顺着既有同步链路自然收敛到所有端，不需要任何新协议。
//
// 协议按 ivyea-agent 的 mcp_client.py 的**实际期望**实现，不是照规范想当然：
//   - JSON-RPC 2.0 over POST，Content-Type: application/json
//   - initialize → 结果里给 protocolVersion / capabilities / serverInfo
//   - notifications/initialized 没有 id，**不能回响应体**
//   - tools/list → {"tools":[...]}
//   - tools/call → {"content":[{"type":"text","text":"..."}]}
//   - 鉴权走 spec 里的 headers，即 Authorization: Bearer <mcp_token>
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/ivyea/ivyea-note/server/internal/store"
)

// MCP 协议版本：与 mcp_client.py 的 initialize 请求保持一致
const mcpProtocolVersion = "2025-06-18"

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErr         `json:"error,omitempty"`
}

// mcpTool 一个工具的声明。inputSchema 用 JSON Schema，agent 侧直接透给模型。
type mcpTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema any    `json:"inputSchema"`
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func mcpTools() []mcpTool {
	vaultProp := map[string]any{
		"type":        "integer",
		"description": "笔记库 id。省略则用该账号的第一个库（多数人只有一个）",
	}
	return []mcpTool{
		{
			Name:        "notes_list",
			Description: "列出笔记库里的全部笔记路径。可用 prefix 只看某个目录。先用它摸清有什么，再去 read。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"vault_id": vaultProp,
					"prefix":   strProp("只列出该目录下的（如 \"日记/\"）"),
				},
			},
		},
		{
			Name:        "notes_read",
			Description: "读一篇笔记的完整 Markdown 正文。path 是库内相对路径，如 \"日记/2026-08-29.md\"。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"vault_id": vaultProp,
					"path":     strProp("库内相对路径"),
				},
				"required": []string{"path"},
			},
		},
		{
			Name: "notes_search",
			Description: "全文搜索笔记正文，返回命中的路径与命中行。" +
				"中文按子串匹配，多个词之间是「都要出现」。找资料先用它，别把整个库读一遍。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"vault_id": vaultProp,
					"query":    strProp("搜索词，空格分隔多个词"),
					"limit":    map[string]any{"type": "integer", "description": "最多返回几篇，默认 20"},
				},
				"required": []string{"query"},
			},
		},
		{
			Name: "notes_backlinks",
			Description: "查哪些笔记用 [[双链]] 指向了这一篇（入链），以及这一篇指向了谁（出链）。" +
				"用来顺着知识网络找上下文。",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"vault_id": vaultProp,
					"path":     strProp("库内相对路径"),
				},
				"required": []string{"path"},
			},
		},
	}
}

// ---------- HTTP 入口 ----------

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	uid, ok := s.mcpAuth(w, r)
	if !ok {
		return
	}
	// 1MB 足够任何一次 JSON-RPC 调用；超了直接截断而不是把内存交给对面
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "请求体不可读")
		return
	}
	var req rpcReq
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPC(w, nil, nil, &rpcErr{Code: -32700, Message: "JSON 解析失败"})
		return
	}
	// 通知（没有 id）：按 JSON-RPC 规范不能回响应体
	if len(req.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	result, rerr := s.mcpDispatch(r.Context(), uid, req)
	writeRPC(w, req.ID, result, rerr)
}

// mcpAuth 只认 MCP 长期令牌。**不接受普通 access token**：那玩意 15 分钟就过期，
// 让机器拿它会导致「今天能用明天不能用」，比直接拒绝更难排查。
func (s *Server) mcpAuth(w http.ResponseWriter, r *http.Request) (int64, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "缺少 Bearer <mcp_token>")
		return 0, false
	}
	uid, err := s.st.GetMCPTokenUser(r.Context(), hashToken(strings.TrimPrefix(h, prefix)))
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "令牌无效或已撤销")
		return 0, false
	}
	return uid, true
}

func writeRPC(w http.ResponseWriter, id json.RawMessage, result any, e *rpcErr) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rpcResp{JSONRPC: "2.0", ID: id, Result: result, Error: e})
}

func (s *Server) mcpDispatch(ctx context.Context, uid int64, req rpcReq) (any, *rpcErr) {
	switch req.Method {
	case "initialize":
		return map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "ivyea-note", "version": "1"},
		}, nil
	case "tools/list":
		return map[string]any{"tools": mcpTools()}, nil
	case "resources/list":
		return map[string]any{"resources": []any{}}, nil
	case "prompts/list":
		return map[string]any{"prompts": []any{}}, nil
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcErr{Code: -32602, Message: "参数不合法"}
		}
		text, err := s.mcpCallTool(ctx, uid, p.Name, p.Arguments)
		if err != nil {
			// 工具级失败按 MCP 约定放进 result.isError，而不是 JSON-RPC error——
			// 后者会让 agent 认为「连接坏了」而不是「这次调用没成功」
			return map[string]any{
				"content": []any{map[string]any{"type": "text", "text": err.Error()}},
				"isError": true,
			}, nil
		}
		return map[string]any{
			"content": []any{map[string]any{"type": "text", "text": text}},
		}, nil
	default:
		return nil, &rpcErr{Code: -32601, Message: "不支持的方法：" + req.Method}
	}
}

// ---------- 工具实现 ----------

func argStr(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func argInt(args map[string]any, key string) int64 {
	switch v := args[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	}
	return 0
}

// resolveVault 定 vault：给了就校验归属，没给就用该账号的第一个库。
func (s *Server) resolveVault(ctx context.Context, uid int64, want int64) (int64, error) {
	vaults, err := s.st.ListVaults(ctx, uid)
	if err != nil {
		return 0, err
	}
	if len(vaults) == 0 {
		return 0, errors.New("这个账号还没有笔记库")
	}
	if want == 0 {
		return vaults[0].ID, nil
	}
	for _, v := range vaults {
		if v.ID == want {
			return v.ID, nil
		}
	}
	return 0, fmt.Errorf("笔记库 %d 不存在或不属于当前账号", want)
}

// loadNotes 把库里存活的 .md 全文读出来。个人规模（几千篇）下一次读全没问题；
// 真到了扛不住的量级，该换的是索引层，不是在这里做半吊子分页。
func (s *Server) loadNotes(ctx context.Context, uid, vaultID int64) ([]noteDoc, error) {
	heads, err := s.st.ListHeads(ctx, vaultID)
	if err != nil {
		return nil, err
	}
	out := make([]noteDoc, 0, len(heads))
	for _, h := range heads {
		if !isMarkdown(h.Path) || h.BlobHash == nil {
			continue
		}
		content, err := s.st.GetBlob(ctx, *h.BlobHash, uid)
		if err != nil {
			continue // 单篇取不到不该让整次调用失败
		}
		out = append(out, noteDoc{Path: h.Path, Content: string(content)})
	}
	return out, nil
}

type noteDoc struct {
	Path    string
	Content string
}

func isMarkdown(p string) bool {
	lower := strings.ToLower(p)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown")
}

func (s *Server) mcpCallTool(ctx context.Context, uid int64, name string, args map[string]any) (string, error) {
	vaultID, err := s.resolveVault(ctx, uid, argInt(args, "vault_id"))
	if err != nil {
		return "", err
	}
	switch name {
	case "notes_list":
		heads, err := s.st.ListHeads(ctx, vaultID)
		if err != nil {
			return "", err
		}
		prefix := argStr(args, "prefix")
		paths := []string{}
		for _, h := range heads {
			if prefix != "" && !strings.HasPrefix(h.Path, prefix) {
				continue
			}
			paths = append(paths, h.Path)
		}
		if len(paths) == 0 {
			return "（没有笔记）", nil
		}
		return fmt.Sprintf("共 %d 篇：\n%s", len(paths), strings.Join(paths, "\n")), nil

	case "notes_read":
		path := argStr(args, "path")
		if path == "" {
			return "", errors.New("缺少 path")
		}
		heads, err := s.st.ListHeads(ctx, vaultID)
		if err != nil {
			return "", err
		}
		for _, h := range heads {
			if h.Path == path && h.BlobHash != nil {
				content, err := s.st.GetBlob(ctx, *h.BlobHash, uid)
				if err != nil {
					return "", fmt.Errorf("读取失败：%w", err)
				}
				return string(content), nil
			}
		}
		return "", fmt.Errorf("没有这篇笔记：%s", path)

	case "notes_search":
		q := argStr(args, "query")
		if q == "" {
			return "", errors.New("缺少 query")
		}
		limit := int(argInt(args, "limit"))
		if limit <= 0 {
			limit = 20
		}
		docs, err := s.loadNotes(ctx, uid, vaultID)
		if err != nil {
			return "", err
		}
		hits := searchNotes(docs, q, limit)
		if len(hits) == 0 {
			return fmt.Sprintf("没有匹配「%s」的笔记。", q), nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%d 篇匹配「%s」：\n", len(hits), q)
		for _, h := range hits {
			fmt.Fprintf(&b, "\n## %s\n", h.Path)
			for _, l := range h.Lines {
				fmt.Fprintf(&b, "  %d: %s\n", l.Line, l.Text)
			}
		}
		return b.String(), nil

	case "notes_backlinks":
		path := argStr(args, "path")
		if path == "" {
			return "", errors.New("缺少 path")
		}
		docs, err := s.loadNotes(ctx, uid, vaultID)
		if err != nil {
			return "", err
		}
		in, out := backlinks(docs, path)
		var b strings.Builder
		fmt.Fprintf(&b, "「%s」的双链：\n\n入链（谁指向它，%d 篇）：\n", path, len(in))
		if len(in) == 0 {
			b.WriteString("  （无）\n")
		}
		for _, p := range in {
			fmt.Fprintf(&b, "  %s\n", p)
		}
		fmt.Fprintf(&b, "\n出链（它指向谁，%d 条）：\n", len(out))
		if len(out) == 0 {
			b.WriteString("  （无）\n")
		}
		for _, p := range out {
			fmt.Fprintf(&b, "  %s\n", p)
		}
		return b.String(), nil
	}
	return "", fmt.Errorf("没有这个工具：%s", name)
}

// ---------- 检索与双链（纯函数，可单测） ----------

// PreviewLine 命中行。行号 1 起，与编辑器一致。
type PreviewLine struct {
	Line int
	Text string
}

// SearchResult 一篇笔记的命中。
type SearchResult struct {
	Path  string
	Lines []PreviewLine
	score int
}

// searchNotes 子串匹配的全文搜索。
//
// 这里**故意不复刻客户端那套 BM25 倒排索引**：服务端没有常驻索引，每次都要现读
// blob；重写一遍排序算法只会得到两份会各自漂移的实现。给模型用的检索，「哪几篇里
// 有这些词、在第几行」已经够——它拿到路径后会自己去 notes_read 读全文。
//
// 多个词之间是 AND：都出现才算命中。大小写不敏感。
func searchNotes(docs []noteDoc, query string, limit int) []SearchResult {
	terms := []string{}
	for _, t := range strings.Fields(strings.ToLower(query)) {
		if t != "" {
			terms = append(terms, t)
		}
	}
	if len(terms) == 0 {
		return nil
	}
	out := []SearchResult{}
	for _, d := range docs {
		lowerAll := strings.ToLower(d.Path + "\n" + d.Content)
		miss := false
		for _, t := range terms {
			if !strings.Contains(lowerAll, t) {
				miss = true
				break
			}
		}
		if miss {
			continue
		}
		res := SearchResult{Path: d.Path}
		for i, line := range strings.Split(d.Content, "\n") {
			ll := strings.ToLower(line)
			for _, t := range terms {
				if strings.Contains(ll, t) {
					res.score++
					if len(res.Lines) < 3 {
						res.Lines = append(res.Lines, PreviewLine{Line: i + 1, Text: trimLine(line)})
					}
					break
				}
			}
		}
		out = append(out, res)
	}
	// 命中行多的排前面；同分按路径稳定排序，避免同样的查询两次给出不同顺序
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func trimLine(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > 120 {
		return string(r[:120]) + "…"
	}
	return s
}

// titleOfPath 去目录去扩展名，[[双链]] 里写的就是这个。
func titleOfPath(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		p = p[i+1:]
	}
	lower := strings.ToLower(p)
	if strings.HasSuffix(lower, ".markdown") {
		return p[:len(p)-len(".markdown")]
	}
	if strings.HasSuffix(lower, ".md") {
		return p[:len(p)-len(".md")]
	}
	return p
}

// extractLinks 抽出正文里的 [[目标]]，支持 [[目标|显示文本]]。
func extractLinks(content string) []string {
	out := []string{}
	rest := content
	for {
		i := strings.Index(rest, "[[")
		if i < 0 {
			break
		}
		j := strings.Index(rest[i+2:], "]]")
		if j < 0 {
			break
		}
		inner := rest[i+2 : i+2+j]
		if k := strings.Index(inner, "|"); k >= 0 {
			inner = inner[:k]
		}
		if t := strings.TrimSpace(inner); t != "" {
			out = append(out, t)
		}
		rest = rest[i+2+j+2:]
	}
	return out
}

// backlinks 返回 (入链路径, 出链目标)。链接按标题匹配，与客户端 wikilink.ts 同一套规则。
func backlinks(docs []noteDoc, path string) (in []string, out []string) {
	title := titleOfPath(path)
	in, out = []string{}, []string{}
	seenIn := map[string]bool{}
	for _, d := range docs {
		links := extractLinks(d.Content)
		if d.Path == path {
			out = append(out, links...)
			continue
		}
		for _, l := range links {
			if l == title && !seenIn[d.Path] {
				seenIn[d.Path] = true
				in = append(in, d.Path)
			}
		}
	}
	sort.Strings(in)
	return in, out
}

// 让 store 包的类型在本文件里有名字可引用（避免 import 只用于签名时被判未使用）
var _ = store.Head{}
