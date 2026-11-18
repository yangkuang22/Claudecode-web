# 出口锁第 2 层：Windows 防火墙规则，让 claude.exe 只能连本机（127.0.0.1 / ::1）。
# 这样就算 TUN 挂了、代理挂了、某个模块不认 HTTPS_PROXY，claude 也连不出去，只会报错。
#
# 用法（需要管理员，会自动请求提权）：
#   egress-firewall.ps1            安装 / 更新规则
#   egress-firewall.ps1 -Remove    删除规则
#   egress-firewall.ps1 -Program D:\xx\claude.exe   指定 claude 路径
#
# 注意：规则对所有 claude.exe 进程生效，包括你在终端里直接运行的 claude。
#       终端里的 claude 也要设置代理才能用：在 ~/.claude/settings.json 加
#       "env": { "HTTPS_PROXY": "http://127.0.0.1:10900", "HTTP_PROXY": "http://127.0.0.1:10900" }
#       （claude-web 会自动给它启动的 claude 设置，不需要这一步）
param([switch]$Remove, [string]$Program)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Remove) { $a += '-Remove' }
  if ($Program) { $a += @('-Program', "`"$Program`"") }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $a
  exit
}

$Name = 'ClaudeWeb 出口锁'
Get-NetFirewallRule -DisplayName "$Name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) {
  Write-Host "`n  已删除防火墙规则「$Name」`n"
  Read-Host '按回车关闭'
  exit
}

if (-not $Program) {
  $c = Get-Command claude.exe -ErrorAction SilentlyContinue
  if ($c) { $Program = $c.Source } else { $Program = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
}
if (-not (Test-Path $Program) -or $Program -notmatch '\.exe$') {
  Write-Host "`n  ✗ 找不到 claude.exe：$Program"
  Write-Host '    如果是 npm 安装的（claude.cmd，实际跑的是 node.exe），不能这样封：会把所有 node 程序一起封掉。'
  Write-Host '    建议改用原生安装版：https://docs.claude.com/claude-code ，或用 -Program 指定路径。'
  Read-Host "`n按回车关闭"
  exit 1
}
$Program = (Resolve-Path $Program).Path

# 阻止规则优先于允许规则；远程地址 = 除回环地址以外的全部
$v4 = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255')
$v6 = @('::', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
New-NetFirewallRule -DisplayName "$Name (IPv4)" -Direction Outbound -Action Block -Program $Program -RemoteAddress $v4 -Profile Any -Description '只允许 claude 连本机代理，防止代理失效时走本机 IP' | Out-Null
try {
  New-NetFirewallRule -DisplayName "$Name (IPv6)" -Direction Outbound -Action Block -Program $Program -RemoteAddress $v6 -Profile Any -Description '只允许 claude 连本机代理，防止代理失效时走本机 IP' -ErrorAction Stop | Out-Null
} catch {
  # 个别系统不接受单独的 '::'，退回只用区间（'::' 本来也不是能连的地址）
  New-NetFirewallRule -DisplayName "$Name (IPv6)" -Direction Outbound -Action Block -Program $Program -RemoteAddress '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' -Profile Any -Description '只允许 claude 连本机代理，防止代理失效时走本机 IP' | Out-Null
}

$off = Get-NetFirewallProfile | Where-Object { -not $_.Enabled }
Write-Host "`n  ✓ 已添加防火墙规则「$Name」"
Write-Host "    程序：$Program"
Write-Host '    效果：这个程序只能连 127.0.0.1 / ::1，其它地址一律拒绝'
if ($off) { Write-Host "`n  ⚠ 这些网络配置的防火墙是关着的，规则在那里不生效：$(($off | ForEach-Object Name) -join ', ')" }
Write-Host "`n  注意：已经在运行的 claude 里，规则生效前建立的连接不会被断开；重启 claude 后才完全受限。"
Write-Host '  删除规则：egress-firewall.ps1 -Remove'
Read-Host "`n按回车关闭"
