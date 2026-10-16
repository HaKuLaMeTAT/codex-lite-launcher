param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
function Get-CoreHash([string]$Path) {
    # 使用 .NET 内置算法，不依赖当前进程的 PowerShell 模块搜索路径。
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
try {
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'codex-optimized-copy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 1) { throw '副本清单格式不支持，请重新生成。' }
    $exe = Join-Path $PSScriptRoot 'ChatGPT.exe'
    $asar = Join-Path $PSScriptRoot 'resources\app.asar'
    # 每次启动先确认核心文件仍配套；更新或手动覆盖后不能误用原来的补丁状态。
    if ((Get-CoreHash $exe) -ne $manifest.candidateExeSha256 -or
        (Get-CoreHash $asar) -ne $manifest.candidateAsarSha256) {
        throw '副本核心文件已变化。请从原安装重新生成，不要混用不同版本的 EXE 和 ASAR。'
    }
    if ($CheckOnly) { Write-Output 'COPY_CORE_VERIFIED'; exit 0 }
    if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) { throw '已有 Codex 正在运行。请先退出原版或其他副本，再启动优化版。' }
    # 继续使用现有账户和设置，不复制用户数据；同一时刻只运行一个版本。
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $exe
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.Arguments = '--disable-features=NonBlockingOsClipboardReads'
    [void][Diagnostics.Process]::Start($info)
} catch {
    if ($CheckOnly) { Write-Error $_.Exception.Message; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Codex 优化副本', 'OK', 'Warning')
    exit 1
}
