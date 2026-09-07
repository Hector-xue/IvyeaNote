; Ivyea Note —— 安装/卸载时维护同步服务端的防火墙放行规则（v0.11.0）。
;
; 为什么在这里做：内置同步服务端 ivnote-server.exe 监听 0.0.0.0:8080（另有发现用的
; UDP 9999）。Windows 防火墙对**公用网络**默认拦截一切入站，而有线网络通常正好被
; 归类成公用网络——于是「电脑插网线、手机连 WiFi」就同步不了，而软件里没有任何
; 地方说得出这件事。装好就把规则写上，绝大多数人从此不会遇到。
;
; 诚实说明：Tauri 的 NSIS 默认是 **currentUser** 安装（不提权），此时 netsh 会失败。
; 这里**故意不弹 UAC**——安装过程中突然要管理员权限比问题本身更吓人。失败也没关系：
; 应用里「设置 → 同步 → 连接诊断」会检测到没有规则，并提供一个按钮当场补上（走一次 UAC）。
; 规则名必须与 src/firewall.rs 里的 RULE_NAME 完全一致，否则应用查不到自己写的规则。

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "正在为同步服务添加防火墙放行规则（失败不影响安装）…"
  ; 先删后加：重装/升级不会堆出一串同名规则
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Ivyea Note Sync Server"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Ivyea Note Sync Server" dir=in action=allow program="$INSTDIR\ivnote-server.exe" enable=yes profile=any'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载要把规则收走：留着一条指向已删除程序的放行规则是垃圾，也是多余的攻击面
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Ivyea Note Sync Server"'
  Pop $0
!macroend
