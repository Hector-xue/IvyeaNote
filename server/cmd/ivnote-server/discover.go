// v0.7.0 H9：局域网发现。
// 服务端监听 UDP 9999 端口，收到 "IVYEA-DISCOVER" 探测包时回 JSON 应答
//（含本机监听端口），客户端据此列出局域网内的 Ivyea Server。
package main

import (
	"encoding/json"
	"log"
	"net"
	"strings"
)

const discoverMagic = "IVYEA-DISCOVER"

// StartDiscoveryListener 阻塞监听 UDP 发现请求；通常放 goroutine。
// listenPort：HTTP 服务端口（应答里告诉客户端往哪连）。
func StartDiscoveryListener(httpPort string) {
	pc, err := net.ListenPacket("udp4", ":9999")
	if err != nil {
		log.Printf("局域网发现未启用（UDP 9999 占用或权限不足）: %v", err)
		return
	}
	go func() {
		<-make(chan struct{}) // 常驻
	}()
	defer pc.Close()
	log.Printf("局域网发现已启用（UDP :9999）")

	buf := make([]byte, 64)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if strings.TrimSpace(string(buf[:n])) != discoverMagic {
			continue
		}
		// 应答：本机所有非环回 IPv4 + HTTP 端口
		ips := localIPv4s()
		resp, _ := json.Marshal(map[string]any{
			"service": "ivyea-note",
			"port":    httpPort,
			"ips":     ips,
		})
		_, _ = pc.WriteTo(resp, addr)
	}
}

func localIPv4s() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.To4() != nil {
				out = append(out, ipnet.IP.String())
			}
		}
	}
	return out
}
