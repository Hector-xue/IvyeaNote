// Web UI 托管：把 desktop 前端产物（vite build --mode web，base=/app/）嵌入二进制，
// 由服务端直接对外提供 /app/ 路径 —— 无需额外静态服务器。
// 构建流程见 deploy/Dockerfile：先在 node 阶段构建前端，把 desktop/dist 拷到本目录
// webui/ 后再编译 Go。仓库内保留占位 index.html，保证未构建时也能编译通过。
package api

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:webui
var webuiEmbedded embed.FS

// handleWebUI 服务 /app/ 子树：精确命中静态文件（带指纹的 assets 长缓存），
// 其余路径回退 index.html（单页应用）。
func (s *Server) handleWebUI(w http.ResponseWriter, r *http.Request) {
	sub, err := fs.Sub(webuiEmbedded, "webui")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "webui_error", err.Error())
		return
	}

	p := strings.TrimPrefix(r.URL.Path, "/app/")
	if p == "" {
		p = "index.html"
	}
	if f, err := sub.Open(p); err == nil {
		st, serr := f.Stat()
		if serr == nil && !st.IsDir() {
			if rs, ok := f.(io.ReadSeeker); ok {
				defer f.Close()
				if strings.HasPrefix(p, "assets/") {
					// vite 指纹文件名，内容不变可永久缓存
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				http.ServeContent(w, r, st.Name(), st.ModTime(), rs)
				return
			}
		}
		_ = f.Close()
	}

	// SPA 回退：任何未命中的路径都给 index.html
	data, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		writeErr(w, http.StatusNotFound, "webui_missing", "Web UI 资源未构建（先执行前端构建再编译服务端）")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}
