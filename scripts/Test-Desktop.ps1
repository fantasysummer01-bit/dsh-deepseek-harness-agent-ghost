param([string]$DesktopRoot = 'D:\ProgramData\deepseek')
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$executable = Join-Path $DesktopRoot 'DeepSeek Harness.exe'
$sdkRoot = Join-Path $DesktopRoot 'resources\app.asar\dsh\node_modules\@deepseek-ai'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Desktop executable absent: $executable" }
$savedNodeMode = $env:ELECTRON_RUN_AS_NODE
$savedSdkRoot = $env:DSH_SDK_ROOT
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:DSH_SDK_ROOT = $sdkRoot
    $testPaths = @('bridge', 'core', 'client', 'host', 'transport') | ForEach-Object { Join-Path $projectRoot "test\$_.test.mjs" }
    $logDir = Join-Path $projectRoot '.runtime'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stdoutFile = Join-Path $logDir 'tests.stdout.log'
    $stderrFile = Join-Path $logDir 'tests.stderr.log'
    $nativeArguments = @('--expose-internals', '--test') + @($testPaths | ForEach-Object { '"' + $_ + '"' })
    $testProcess = Start-Process -FilePath $executable -ArgumentList $nativeArguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    Get-Content -LiteralPath $stdoutFile
    Get-Content -LiteralPath $stderrFile
    if ($testProcess.ExitCode -ne 0) { throw "Ghost tests failed with exit code $($testProcess.ExitCode)" }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $savedNodeMode
    $env:DSH_SDK_ROOT = $savedSdkRoot
}
