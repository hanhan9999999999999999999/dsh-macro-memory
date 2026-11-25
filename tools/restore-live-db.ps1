# restore-live-db.ps1 — 2026-11-25 记忆库事故的复原开关（一次性工具，可留可删）
#
# 背景：2026-11-25 16:38 的 sync-trees 把源树里 4,096 字节的空壳 fixture memory.db
#       覆盖到了本工作区的活库上，活库报废。事后从「会话转写 + 事故前 dump + 11-17 老快照」
#       三路抠回 2,202 条，重新整理成一份干净单文件库。
#
# 用法（必须先把 DSH 完全退出，否则文件被占用、覆盖会失败）：
#   powershell -ExecutionPolicy Bypass -File tools\restore-live-db.ps1 -DryRun   # 只体检，不写盘
#   powershell -ExecutionPolicy Bypass -File tools\restore-live-db.ps1           # 真复原
#   powershell -ExecutionPolicy Bypass -File tools\restore-live-db.ps1 -Workspace <工作区> -Source <别的库>
#
# 它做四件事：
#   1) 拒绝在 DSH 还活着的时候动手（避免和活进程抢同一次 checkpoint）
#   2) 把现有 .dsh-meow 三件套备份到 D:\备份\<时间戳>-before-restore-live\
#   3) 覆盖 memory.db，**并删掉 -wal / -shm**（旧 WAL 里是坏盐帧，留着会被回放）
#   4) 事后自检：文件大小、只读打开 integrity_check、七层计数
param(
  [string]$Source = 'D:\document\DSH Memory Macro-Regulation System\.dsh-meow\restore\20261125-restored-memory.db',
  [string]$Workspace = 'D:\document\DSH Memory Macro-Regulation System',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$meow = Join-Path $Workspace '.dsh-meow'
$live = Join-Path $meow 'memory.db'
$levels = @('soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules')

function Fail($msg) { Write-Host "[restore] 中止：$msg" -ForegroundColor Red; exit 1 }

Write-Host "[restore] 源库 $Source"
if (-not (Test-Path -LiteralPath $Source)) { Fail "找不到源库" }
$srcSize = (Get-Item -LiteralPath $Source).Length
Write-Host ("[restore] 源库大小 {0:N0} 字节" -f $srcSize)
if ($srcSize -lt 1MB) { Fail "源库只有 $srcSize 字节，像空壳库，不像整顿过的那份" }

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DSH NEXT' }
if ($running -and -not $DryRun) {
  Fail ("DSH 还在跑（{0} 个进程：{1}）——先完全退出 DSH 再跑本脚本" -f $running.Count, (($running.Id | Sort-Object) -join ','))
}
if ($running) { Write-Host ("[restore] 提示：DSH 在跑（{0} 个进程），真复原前要退出" -f $running.Count) -ForegroundColor Yellow }

Write-Host "[restore] 现有活库"
foreach ($f in 'memory.db', 'memory.db-shm', 'memory.db-wal') {
  $p = Join-Path $meow $f
  if (Test-Path -LiteralPath $p) { Write-Host ("         {0}  {1:N0} 字节  {2}" -f $f, (Get-Item -LiteralPath $p).Length, (Get-Item -LiteralPath $p).LastWriteTime) }
  else { Write-Host "         $f  （没有）" }
}

if ($DryRun) {
  Write-Host "[restore] -DryRun：只体检，不写盘。计划：备份三件套 → 覆盖 memory.db → 删 -wal/-shm → 自检" -ForegroundColor Cyan
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "D:\备份\$stamp-before-restore-live"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
foreach ($f in 'memory.db', 'memory.db-shm', 'memory.db-wal') {
  $p = Join-Path $meow $f
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $in = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
  try {
    $out = [System.IO.File]::Create((Join-Path $backup $f))
    try { $in.CopyTo($out) } finally { $out.Close() }
  } finally { $in.Close() }
}
Write-Host "[restore] 已备份到 $backup"

# 先删伴生文件再覆盖：SQLite 见到旧 -wal 会尝试回放，坏盐帧会把新库带歪
foreach ($f in 'memory.db-shm', 'memory.db-wal') {
  $p = Join-Path $meow $f
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Host "[restore] 已删除 $f" }
}
Copy-Item -LiteralPath $Source -Destination $live -Force
Write-Host ("[restore] 已覆盖 memory.db（{0:N0} 字节）" -f (Get-Item -LiteralPath $live).Length)

# 自检：只读打开 + integrity_check + 七层计数
Add-Type -AssemblyName System.Data.SQLite -ErrorAction SilentlyContinue
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) {
  $probe = @'
import sqlite3, sys
p = sys.argv[1]
c = sqlite3.connect('file:%s?mode=ro' % p.replace('\\','/'), uri=True)
print('integrity', c.execute('pragma integrity_check').fetchone()[0])
total = 0
for t in ('soul','user','project','fact','lesson','topic','rules'):
    n = c.execute('select count(*) from %s' % t).fetchone()[0]
    total += n
    print('  %-8s %d' % (t, n))
print('total', total)
'@
  $tmp = Join-Path $env:TEMP ('restore-check-' + $stamp + '.py')
  Set-Content -LiteralPath $tmp -Value $probe -Encoding UTF8
  & python $tmp $live
  Remove-Item -LiteralPath $tmp -Force
} else {
  Write-Host '[restore] 没找到 python，跳过 SQL 自检（大小已核对）'
}

Write-Host ''
Write-Host '[restore] 完成。现在重新启动 DSH，记忆库即生效。' -ForegroundColor Green
Write-Host "[restore] 备份（出问题先还原它）：$backup"
Write-Host '[restore] 还原办法：退出 DSH → 把备份目录里的 memory.db / -wal / -shm 拷回 .dsh-meow\ → 启动。'
