# Ivyea Note Windows 部署助手（由 start.bat 以 UTF-8 方式加载执行）
# 职责：生成 .env（含随机管理员密码）→ 启动服务 → 在桌面生成「IvyeaNote-账号.txt」
$ErrorActionPreference = 'Stop'

function Get-DotEnv([string]$key) {
    $line = Select-String -Path .env -Pattern ("^" + [regex]::Escape($key) + "=") | Select-Object -First 1
    if ($line) { return $line.Line.Substring($key.Length + 1).Trim() }
    return ""
}

# ---------- 1) 准备 .env ----------
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env

    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

    $bytes16 = New-Object byte[] 16
    $rng.GetBytes($bytes16)
    $pgpw = ($bytes16 | ForEach-Object { $_.ToString('x2') }) -join ''

    $adminpw = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })

    $raw = Get-Content .env -Raw
    $raw = $raw.Replace('change-me-to-a-long-random-string', $secret)
    $raw = $raw.Replace('change-me-too', $pgpw)
    $raw = $raw -replace '(?m)^IVNOTE_ADMIN_PASSWORD=.*', ("IVNOTE_ADMIN_PASSWORD=" + $adminpw)
    # 本机部署默认无域名：清空占位域名，服务器地址将使用 http://127.0.0.1:8080
    $raw = $raw -replace '(?m)^IVNOTE_DOMAIN=.*', 'IVNOTE_DOMAIN='
    Set-Content .env -Value $raw -Encoding UTF8
    Write-Host ''
    Write-Host '已生成 .env（已包含随机管理员密码）'
}

$adminEmail    = Get-DotEnv 'IVNOTE_ADMIN_EMAIL';    if (-not $adminEmail)    { $adminEmail = 'admin@example.com' }
$adminPassword = Get-DotEnv 'IVNOTE_ADMIN_PASSWORD'
$domain        = Get-DotEnv 'IVNOTE_DOMAIN'

# ---------- 2) 启动服务（优先官方镜像，拉不到则本地构建） ----------
$image = 'ghcr.io/hector-xue/ivyeanote/ivnote-server:latest'
Write-Host ''
Write-Host '正在启动 Ivyea Note 服务…'
docker pull $image *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host '使用官方镜像部署'
    docker compose -f docker-compose.prod.yml up -d
} else {
    Write-Host '官方镜像不可用，改为本地构建（首次约需几分钟，请耐心等待）…'
    docker compose up -d --build
}
if ($LASTEXITCODE -ne 0) { throw 'docker compose 启动失败，请把上方报错截图反馈给开发者' }

# ---------- 3) 等待服务就绪 ----------
$ready = $false
foreach ($i in 1..20) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/healthz' -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}

# ---------- 4) 生成账号文件到桌面 ----------
$serverUrl = 'http://127.0.0.1:8080'
if ($domain) { $serverUrl = 'https://' + $domain }

$lines = @(
    'Ivyea Note 登录信息（请妥善保管）',
    '=============================================',
    '',
    "服务器地址: $serverUrl",
    "账号: $adminEmail",
    "密码: $(if ($adminPassword) { $adminPassword } else { '（见下方说明）' })",
    '',
    '使用方法:',
    '1) 打开 Ivyea Note 客户端（开始菜单里找 Ivyea Note）',
    '2) 在登录页点「导入账号文件」，选择本文件，三栏自动填好',
    '3) 点登录，开始记笔记',
    '',
    '说明:',
    '- 「服务器地址」就是本文件的「服务器地址」一栏，导入后不用改。',
    '- 想改密码：编辑 deploy\.env 里的 IVNOTE_ADMIN_PASSWORD，然后重新双击 start.bat。'
)
if (-not $adminPassword) {
    $lines += '⚠ 你把密码留空了：初始密码在容器日志里（命令行进入 deploy 目录执行 docker compose logs app）。'
}

$desktop = [Environment]::GetFolderPath('Desktop')
$accFile = Join-Path $desktop 'IvyeaNote-账号.txt'
[System.IO.File]::WriteAllLines($accFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($ready) { Write-Host '✅ 部署完成，服务已在本机运行！' }
else       { Write-Host '✅ 部署完成（服务还在启动中，稍等半分钟即可使用）' }
Write-Host "📄 账号文件已放到桌面: $accFile"

Start-Process notepad $accFile
