package api

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Hub 维护在线 WS 连接，按用户广播 dirty 通知。
type client struct {
	conn     *websocket.Conn
	userID   int64
	deviceID string
	send     chan []byte
}

type Hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

func NewHub() *Hub { return &Hub{clients: make(map[*client]struct{})} }

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // 同源由反代保证；MVP 放开
}

// HandleWS 升级连接并常驻读泵（仅保活），写泵走 channel。
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request, userID int64, deviceID string) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	cl := &client{conn: c, userID: userID, deviceID: deviceID, send: make(chan []byte, 16)}
	h.mu.Lock()
	h.clients[cl] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, cl)
		h.mu.Unlock()
		_ = c.Close()
	}()

	go h.writePump(cl)

	c.SetReadLimit(1024)
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			break
		}
	}
}

func (h *Hub) writePump(cl *client) {
	for msg := range cl.send {
		_ = cl.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := cl.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

// BroadcastDirty 通知某用户除 excludeDevice 外的所有在线设备拉取增量。
func (h *Hub) BroadcastDirty(userID, vaultID int64, excludeDevice string) {
	msg, _ := json.Marshal(map[string]any{"event": "dirty", "vault_id": vaultID})
	h.mu.Lock()
	defer h.mu.Unlock()
	for cl := range h.clients {
		if cl.userID != userID || cl.deviceID == excludeDevice {
			continue
		}
		select {
		case cl.send <- msg:
		default: // 发送缓冲满则丢弃，客户端靠轮询兜底
		}
	}
}
