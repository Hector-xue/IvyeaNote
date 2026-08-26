# Ivyea Note Windows 免 Docker 向导（v0.7.0 W1）
# 用法：下载 ivnote-server-windows-amd64.exe 后，双击 ivnote-win-setup.ps1
#       或在 PowerShell 里执行：powershell -ExecutionPolicy Bypass -File ivnote-win-setup.ps1
# 职责：生成配置 → 启动服务（前台窗口，关窗即停；可选注册计划任务开机自启）→ 桌面生成账号文件
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'ivnote-server.exe'
if (-not (Test-Path $exe)) {
    Write-Host "未找到 $exe"
    Write-Host '请先从 GitHub Release 下载 ivnote-server-windows-amd64.exe 并放到本目录，重命名为 ivnote-server.exe'
    Read-Host '按回车退出'
    exit 1
}

$dataDir = Join-Path $dir 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# ---------- 1) 生成配置（仅首次） ----------
$cfg = Join-Path $dataDir '.configured'
if (-not (Test-Path $cfg)) {
    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
    $bytes = New-Object byte[] 16
    $rng.GetBytes($bytes)
    $adminpw = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''.Substring(0,0) | ForEach-Object { $_ }
    $adminpw = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
    $email = Read-Host '管理员邮箱（直接回车用 admin@example.com）'
    if (-not $email) { $email = 'admin@example.com' }
    Set-Content $cfg -Value "IVNOTE_ADMIN_EMAIL=$email`nIVNOTE_ADMIN_PASSWORD=$adminpw" -Encoding UTF8
    Write-Host '已生成配置。'
}
$lines = Get-Content $cfg
$adminEmail = ($lines | Select-String '^IVNOTE_ADMIN_EMAIL=').Line.Substring('IVNOTE_ADMIN_EMAIL='.Length)
$adminPassword = ($lines | Select-String '^IVNOTE_ADMIN_PASSWORD=').Line.Substring('IVNOTE_ADMIN_PASSWORD='.Length)

# ---------- 2) 启动（新窗口常驻；SQLite 零依赖） ----------
Write-Host '启动 Ivyea Note 服务（SQLite 模式，无需 Docker/PostgreSQL）…'
$env:IVNOTE_DATA_DIR = $dataDir
$env:IVNOTE_LISTEN = ':8080'
Start-Process -FilePath $exe -WorkingDirectory $dir -WindowStyle Minimized

# ---------- 3) 等待就绪 ----------
$ready = $false
foreach ($i in 1..15) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/healthz' -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}

# ---------- 4) 本机 IP（手机同 WiFi 连接用） ----------
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -First 1).IPAddress

# ---------- 5) 账号文件 ----------
$serverLocal = "http://127.0.0.1:8080"
$serverLan = if ($ip) { "http://${ip}:8080" } else { $null }
$acc = @(
    'Ivyea Note 登录信息（请妥善保管）',
    '=============================================',
    '',
    "服务器地址（本机）: $serverLocal"
)
if ($serverLan) { $acc += "服务器地址（手机/其他电脑，同一 WiFi）: $serverLan" }
$acc += @(
    "账号: $adminEmail",
    "密码: $adminPassword",
    '',
    '使用方法:',
    '1) 打开 Ivyea Note 客户端',
    '2) 登录页点「导入账号文件」，选择本文件',
    '3) 点登录，开始记笔记',
    '',
    '说明:',
    '- 服务在本窗口/后台运行，关机后需重新运行本脚本（或注册计划任务开机自启）',
    "- 数据库: $dataDir\ivnote.db（备份它 = 备份全部数据）"
)
$desktop = [Environment]::GetFolderPath('Desktop')
$accFile = Join-Path $desktop 'IvyeaNote-账号.txt'
[System.IO.File]::WriteAllLines($accFile, $acc, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($ready) { Write-Host '✅ 服务已启动！' } else { Write-Host '✅ 部署完成（服务启动中，稍等半分钟）' }
Write-Host "📄 账号文件已放到桌面: $accFile"
$auto = Read-Host '是否注册开机自启（计划任务）？(y/N)'
if ($auto -eq 'y') {
    $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $dir
    $trigger = New-ScheduledTaskTrigger -AtLogon
    Register-ScheduledTask -TaskName 'IvyeaNoteServer' -Action $action -Trigger $trigger -Force | Out-Null
    Write-Host '✅ 已注册开机自启任务 IvyeaNoteServer'
}
Read-Host '按回车退出'
