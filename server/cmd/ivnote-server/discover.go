// v0.7.0 H9：局域网发现。
// 服务端监听 UDP 9999 端口，收到 "IVYEA-DISCOVER" 探测包时回 JSON 应答
// （含本机监听端口），客户端据此列出局域网内的 Ivyea Server。
package main

import (
	"encoding/json"
	"log"
	"net"
	"sort"
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

// localIPv4s 返回本机非环回 IPv4，**按"手机最可能连得上"排序**。
//
// 客户端过去直接取第一项当地址，而这里的顺序是网卡枚举顺序：一台装了
// Docker Desktop / WSL / VMware / VirtualBox 的 Windows，排在前面的往往是
// 172.17.x.x、192.168.56.x 这类只有本机能走的虚拟网卡 —— 手机拿到就连不上。
// 家用局域网几乎都是 192.168.x.x，其次 10.x，虚拟网卡的常见网段排到最后。
func localIPv4s() []string {
	type cand struct {
		ip   string
		rank int
	}
	var cands []cand
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil || ipnet.IP.IsLinkLocalUnicast() {
				continue
			}
			cands = append(cands, cand{ipnet.IP.String(), rankIP(ipnet.IP, iface.Name)})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].rank < cands[j].rank })
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.ip)
	}
	return out
}

// rankIP：越小越可能是"手机也走得通"的那块网卡。
func rankIP(ip net.IP, ifaceName string) int {
	name := strings.ToLower(ifaceName)
	for _, bad := range []string{"docker", "veth", "br-", "vmnet", "vboxnet", "wsl", "hyper-v", "virtual", "tailscale", "zt", "utun", "tun", "tap"} {
		if strings.Contains(name, bad) {
			return 90
		}
	}
	v4 := ip.To4()
	switch {
	case v4[0] == 192 && v4[1] == 168:
		// VirtualBox 默认 192.168.56.0/24、VMware 常用 192.168.x —— 56 单独降一档
		if v4[2] == 56 {
			return 40
		}
		return 10
	case v4[0] == 10:
		return 20
	case v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31:
		// 172.17.0.1 是 Docker 默认网桥，最不可能是家里的 Wi-Fi
		if v4[1] == 17 || v4[1] == 18 {
			return 80
		}
		return 30
	default:
		return 50
	}
}
