param([switch]$SmokeTest, [string]$TargetPath, [string]$ScreenshotPath,
    [ValidateSet('copy','inplace')][string]$Mode = 'copy')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Resolve-Asar([string]$SelectedPath) {
    if ([string]::IsNullOrWhiteSpace($SelectedPath)) { throw '请先选择 Codex 安装目录。' }
    $resolved = [IO.Path]::GetFullPath($SelectedPath)
    $candidates = @($resolved, (Join-Path $resolved 'app.asar'),
        (Join-Path $resolved 'resources\app.asar'), (Join-Path $resolved 'app\resources\app.asar'))
    foreach ($candidate in $candidates) {
        if ((Split-Path $candidate -Leaf) -eq 'app.asar' -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw '所选位置没有找到 app.asar。请选择 Codex 安装目录或 resources 目录。'
}

function Find-Installation {
    $candidates = @()
    foreach ($process in @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)) {
        if ($process.Path) { $candidates += Join-Path (Split-Path $process.Path) 'resources\app.asar' }
    }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Codex\resources\app.asar' }
    $found = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
    if ($found.Count -eq 1) { return $found[0] }
    return ''
}

$form = New-Object Windows.Forms.Form
$form.Text = 'Codex 轻启 v0.6.0'
$form.ClientSize = New-Object Drawing.Size(720, 580)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)

$title = New-Object Windows.Forms.Label
$title.Text = 'Codex 优化：独立副本 / 原位升级'
$title.Font = New-Object Drawing.Font('Microsoft YaHei UI', 14, [Drawing.FontStyle]::Bold)
$title.SetBounds(22, 20, 630, 34)
$form.Controls.Add($title)
$description = New-Object Windows.Forms.Label
$description.Text = '仅写入新目录，不修改原安装。支持从已打 v0.3.0 补丁的安装生成副本。'
$description.SetBounds(22, 60, 680, 26)
$form.Controls.Add($description)
$modeBox = New-Object Windows.Forms.ComboBox
$modeBox.DropDownStyle = 'DropDownList'
[void]$modeBox.Items.Add('独立副本：保留来源安装')
[void]$modeBox.Items.Add('原位升级：替换配套 EXE 和 ASAR')
$modeBox.SetBounds(22, 96, 675, 29)
$modeBox.SelectedIndex = if ($Mode -eq 'inplace') { 1 } else { 0 }
$form.Controls.Add($modeBox)
$location = New-Object Windows.Forms.TextBox
$location.SetBounds(22, 143, 565, 29)
$form.Controls.Add($location)
$browse = New-Object Windows.Forms.Button
$browse.Text = '选择来源'
$browse.SetBounds(596, 141, 101, 32)
$form.Controls.Add($browse)

$outputPath = New-Object Windows.Forms.TextBox
$outputPath.SetBounds(22, 197, 565, 29)
$outputPath.Text = Join-Path $PSScriptRoot 'copies\Codex-optimized'
$form.Controls.Add($outputPath)
$outputBrowse = New-Object Windows.Forms.Button
$outputBrowse.Text = '副本位置'
$outputBrowse.SetBounds(596, 195, 101, 32)
$form.Controls.Add($outputBrowse)

$checkButton = New-Object Windows.Forms.Button
$checkButton.Text = '检查来源'
$checkButton.SetBounds(22, 247, 100, 36)
$applyButton = New-Object Windows.Forms.Button
$applyButton.Text = '生成副本'
$applyButton.SetBounds(134, 247, 100, 36)
$applyButton.Enabled = $false
$openButton = New-Object Windows.Forms.Button
$openButton.Text = '打开副本目录'
$openButton.SetBounds(378, 247, 130, 36)
$openButton.Enabled = $false
$restoreButton = New-Object Windows.Forms.Button
$restoreButton.Text = '原位回滚'
$restoreButton.SetBounds(246, 247, 120, 36)
$restoreButton.Enabled = $false
$form.Controls.AddRange(@($checkButton, $applyButton, $restoreButton, $openButton))

$status = New-Object Windows.Forms.Label
$status.Text = '请选择来源安装目录，然后检查。'
$status.SetBounds(22, 300, 675, 27)
$form.Controls.Add($status)
$details = New-Object Windows.Forms.TextBox
$details.Multiline = $true
$details.ReadOnly = $true
$details.ScrollBars = 'Vertical'
$details.SetBounds(22, 333, 675, 171)
$details.Text = "生成期间可以继续使用当前 Codex；不要同时更新来源安装。`r`n副本包含完整运行资源，另占一份安装的磁盘空间。`r`n生成后不会自动启动或替换原版入口。"
$form.Controls.Add($details)
$note = New-Object Windows.Forms.Label
$note.Text = '实验工具，需要 Node.js 20+。原位升级/回滚前须完全退出 Codex。'
$note.SetBounds(22, 528, 675, 28)
$form.Controls.Add($note)

$script:worker = $null
$script:operation = ''
$script:smokeExit = 1
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200

function Reset-Mode {
    $inplace = $modeBox.SelectedIndex -eq 1
    $applyButton.Text = if ($inplace) { '原位升级' } else { '生成副本' }
    $description.Text = if ($inplace) { '配套替换 EXE/ASAR；先备份升级前版本，保留现有启动方式。' } else { '仅写入新目录，不修改来源安装；支持从已原位升级的安装生成副本。' }
    $outputPath.Enabled = -not $inplace; $outputBrowse.Enabled = -not $inplace
    $restoreButton.Visible = $inplace; $openButton.Visible = -not $inplace
    $applyButton.Enabled = $false; $restoreButton.Enabled = $false; $openButton.Enabled = $false
    $status.Text = '请检查所选安装。'
    $details.Text = if ($inplace) { "检查期间可保持 Codex 运行。`r`n升级/回滚前请完全退出桌面应用和 Codex CLI，保留此工具窗口。`r`n首次升级约需 1 GiB 临时可用空间，完成后保留约 0.51 GiB 配套回滚备份。" } else { "生成期间可继续使用来源安装；不要同时更新它。`r`n副本另占约 2.2 GiB 空间；完成后不会自动启动或切换入口。" }
}

function Start-Operation([string]$Command) {
    try {
        $asar = Resolve-Asar $location.Text
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw '未找到 Node.js。请安装 Node.js 20 或更新版本，然后重新打开补丁工具。' }
        $versionText = & $nodeCommand.Source --version
        if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
            throw '需要 Node.js 20 或更新版本。请更新后重新打开补丁工具。'
        }
        $location.Text = $asar
        $script:operation = $Command
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $nodeCommand.Source
        # 路径只作为独立参数传给 Node，不拼接进可执行脚本。
        $backend = if ($modeBox.SelectedIndex -eq 1) { 'inplace.mjs' } else { 'copy.mjs' }
        $info.Arguments = '"' + (Join-Path $PSScriptRoot $backend) + '" ' + $Command + ' "' + $asar + '"'
        if ($Command -eq 'create') {
            if ([string]::IsNullOrWhiteSpace($outputPath.Text)) { throw '请设置一个尚不存在的副本目录。' }
            $destination = [IO.Path]::GetFullPath($outputPath.Text)
            if ($destination.Contains('"')) { throw '副本目录不能包含双引号。' }
            $info.Arguments += ' "' + $destination.TrimEnd('\') + '"'
        }
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.Encoding]::UTF8
        $info.StandardErrorEncoding = [Text.Encoding]::UTF8
        $script:worker = New-Object Diagnostics.Process
        $script:worker.StartInfo = $info
        [void]$script:worker.Start()
        # 异步读取管道，避免长输出阻塞；UI 定时器只收取完成结果。
        $script:stdoutTask = $script:worker.StandardOutput.ReadToEndAsync()
        $script:stderrTask = $script:worker.StandardError.ReadToEndAsync()
        foreach ($control in @($modeBox, $location, $browse, $outputPath, $outputBrowse, $checkButton, $applyButton, $restoreButton, $openButton)) { $control.Enabled = $false }
        $status.Text = @{ inspect = '正在检查来源…'; create = '正在复制并校验完整应用，请等待…'; apply = '正在备份、校验并原位升级…'; restore = '正在校验并回滚升级前版本…' }[$Command]
        $timer.Start()
    } catch {
        $status.Text = '未执行操作'
        $details.Text = $_.Exception.Message
        if ($SmokeTest) { $form.Close() }
    }
}

$timer.Add_Tick({
    if ($null -eq $script:worker -or -not $script:worker.HasExited) { return }
    $timer.Stop()
    try {
        $output = $script:stdoutTask.Result
        $errorText = $script:stderrTask.Result
        if ($script:worker.ExitCode -ne 0) { throw $errorText.Trim() }
        $result = $output | ConvertFrom-Json
        $applyButton.Enabled = $result.status -eq 'copy-ready'
        $openButton.Enabled = $result.status -eq 'copy-created'
        $restoreButton.Enabled = $false
        switch ($result.status) {
            'copy-ready' {
                $status.Text = '来源检查通过，可以生成独立副本'
                $origin = if ($result.useVerifiedBackups) { '使用经过验证的配套备份；来源安装保持不动。' } else { '使用经过验证的安装文件；来源保持不动。' }
                $size = [math]::Round($result.estimatedBytes / 1GB, 2)
                $details.Text = "应用版本：$($result.version)`r`n$origin`r`n约需 $size GiB 磁盘空间，$($result.fileCount) 个运行文件。`r`n确认副本位置后点击「生成副本」。"
            }
            'copy-created' {
                $status.Text = '独立优化副本已生成并完成文件校验'
                $script:lastOutput = $result.output
                $details.Text = "副本：$($result.output)`r`n启动入口：$($result.launcher)`r`n退出其他 Codex 后，双击副本中的启动入口。`r`n原安装和启动方式未改动；此操作没有自动启动副本。"
            }
            { $_ -in @('upgrade-ready','upgrade-applied','upgrade-restored') } {
                $restoreButton.Enabled = $result.canRestore
                $applyButton.Enabled = $result.state -in @('ready','patched')
                $required = [math]::Round($result.requiredFreeBytes / 1GB, 2)
                $free = [math]::Round($result.freeBytes / 1GB, 2)
                if ($result.state -eq 'partial') { $status.Text = '检测到半完成替换，请保持 Codex 关闭并原位回滚' }
                elseif ($result.state -eq 'upgraded') { $status.Text = '当前安装已完成优化，可按原方式启动' }
                elseif ($result.status -eq 'upgrade-restored') { $status.Text = '已回滚至本次原位升级前的版本' }
                else { $status.Text = '检查通过，退出 Codex 后可原位升级' }
                $details.Text = "应用版本：$($result.version)`r`n本次准备约需 $required GiB 可用空间，当前可用 $free GiB。`r`n回滚备份：$($result.backup)`r`nEXE 备份：$($result.exeBackup)`r`n升级和回滚同时处理两个文件；不会自动关闭或启动 Codex。"
            }
            default { throw '工具返回了未知状态，请检查补丁文件是否完整。' }
        }
        $script:smokeExit = 0
    } catch {
        $status.Text = '操作未完成'
        $details.Text = $_.Exception.Message + "`r`n请处理上述原因后重新检查。若提示访问被拒绝，请确认目录权限。"
    } finally {
        $script:worker.Dispose()
        $script:worker = $null
        $location.Enabled = $true; $browse.Enabled = $true; $checkButton.Enabled = $true
        $modeBox.Enabled = $true
        $outputPath.Enabled = $modeBox.SelectedIndex -eq 0; $outputBrowse.Enabled = $modeBox.SelectedIndex -eq 0
        if ($ScreenshotPath) {
            $bitmap = New-Object Drawing.Bitmap($form.Width, $form.Height)
            $form.DrawToBitmap($bitmap, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
            $bitmap.Save($ScreenshotPath, [Drawing.Imaging.ImageFormat]::Png)
            $bitmap.Dispose()
        }
        if ($SmokeTest) { $form.Close() }
    }
})
$location.Add_TextChanged({ $applyButton.Enabled = $false; $restoreButton.Enabled = $false; $openButton.Enabled = $false })
$modeBox.Add_SelectedIndexChanged({ Reset-Mode })
$outputPath.Add_TextChanged({ $openButton.Enabled = $false })
$browse.Add_Click({
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择 Codex 安装目录或 resources 目录'
    if ($dialog.ShowDialog() -eq 'OK') { $location.Text = $dialog.SelectedPath }
    $dialog.Dispose()
})
$checkButton.Add_Click({ Start-Operation 'inspect' })
$applyButton.Add_Click({ if ($modeBox.SelectedIndex -eq 1) { Start-Operation 'apply' } else { Start-Operation 'create' } })
$restoreButton.Add_Click({ Start-Operation 'restore' })
$outputBrowse.Add_Click({
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    $dialog.Description = '选择副本的父目录；将在其中新建 Codex-optimized 子目录'
    if ($dialog.ShowDialog() -eq 'OK') { $outputPath.Text = Join-Path $dialog.SelectedPath 'Codex-optimized' }
    $dialog.Dispose()
})
$openButton.Add_Click({ if ($script:lastOutput) { Start-Process explorer.exe -ArgumentList ('"' + $script:lastOutput + '"') } })
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -ne $script:worker) { $eventArgs.Cancel = $true; $status.Text = '请等待当前操作完成后关闭。' }
})
$form.Add_Shown({
    Reset-Mode
    if ($TargetPath) { $location.Text = $TargetPath } else { $location.Text = Find-Installation }
    if ($location.Text) { Start-Operation 'inspect' }
    elseif ($SmokeTest) { $form.Close() }
})
if ($SmokeTest) { $form.ShowInTaskbar = $false; $form.Opacity = 0 }
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
if ($SmokeTest) { exit $script:smokeExit }
