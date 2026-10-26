param(
    [string]$DesktopCli = 'D:\ProgramData\deepseek\resources\runtime\cli\bin\dsh.cmd'
)
$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshRoot 'profiles\desktop'
if (-not (Test-Path -LiteralPath $DesktopCli -PathType Leaf)) { throw "Desktop CLI absent: $DesktopCli" }
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) { throw 'Desktop profile has not been initialized.' }
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { throw 'Please finish active tasks and completely exit DSH (including its tray) before installing.' }
$backupDir = Join-Path $pluginRoot ('artifacts\profile-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDir | Out-Null
$manifest = @()
foreach ($fileName in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml')) {
    $sourcePath = Join-Path $profileDir $fileName
    $existed = Test-Path -LiteralPath $sourcePath -PathType Leaf
    if ($existed) { Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupDir $fileName) }
    $manifest += @{ name = $fileName; existed = $existed; sha256 = $(if ($existed) { (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash } else { $null }) }
}
@{ profile = $profileDir; plugin = $pluginRoot; files = $manifest; createdAt = [DateTimeOffset]::Now.ToString('o') } |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $backupDir 'backup-manifest.json') -Encoding utf8
Write-Host "Profile backup: $backupDir"
& $DesktopCli plugin --profile desktop add $pluginRoot
if ($LASTEXITCODE -ne 0) { throw "DSH plugin manager failed with exit code $LASTEXITCODE. Backup preserved at $backupDir" }
Write-Host 'Installed dsh-ghost. Start DSH, then open Settings > Ghost. Capture is disabled by default.'
