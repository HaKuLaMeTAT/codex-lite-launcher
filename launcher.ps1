param([switch]$SmokeTest, [string]$TargetPath, [string]$ScreenshotPath,
    [ValidateSet('copy','inplace')][string]$Mode = 'copy', [string]$SelectedOptions = 'default',
    [ValidateRange(1,180)][int]$InactiveMinutes = 5)

$ErrorActionPreference = 'Stop'
$script:inactiveMinutesExplicit = $PSBoundParameters.ContainsKey('InactiveMinutes')
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
$form.Text = 'Codex 轻启 v0.12.0'
$form.ClientSize = New-Object Drawing.Size(720, 800)
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

# 从共享目录读取默认值；基础六项默认选中，后续运行时优化按需勾选。
# Windows PowerShell 5.1 的 ConvertFrom-Json 将数组作为单个管道对象输出，直接赋值避免再包一层。
$optionDefinitions = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'options.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$optionLabel = New-Object Windows.Forms.Label
$optionLabel.Text = '性能优化项（默认基础 6 项）'
$optionLabel.SetBounds(22, 236, 315, 24)
$form.Controls.Add($optionLabel)
$retentionLabel = New-Object Windows.Forms.Label
$retentionLabel.Text = '会话保留（1–180 分钟）'
$retentionLabel.SetBounds(360, 236, 245, 24)
$form.Controls.Add($retentionLabel)
$retentionMinutes = New-Object Windows.Forms.NumericUpDown
$retentionMinutes.Minimum = 1; $retentionMinutes.Maximum = 180
$retentionMinutes.Value = $InactiveMinutes
$retentionMinutes.SetBounds(617, 233, 80, 28)
$form.Controls.Add($retentionMinutes)
$optionList = New-Object Windows.Forms.CheckedListBox
$optionList.CheckOnClick = $true
$optionList.MultiColumn = $true
$optionList.ColumnWidth = 332
$optionList.IntegralHeight = $false
$optionList.SetBounds(22, 264, 675, 196)
foreach ($option in $optionDefinitions) {
    $checked = $SelectedOptions -eq 'all' -or ($SelectedOptions -eq 'default' -and $option.default) -or ($SelectedOptions -split ',') -contains $option.id
    [void]$optionList.Items.Add($option.label, $checked)
}
$form.Controls.Add($optionList)
$retentionIndex = @($optionDefinitions.id).IndexOf('inactive-thread-unsubscribe')
$retentionMinutes.Enabled = $optionList.GetItemChecked($retentionIndex)

$checkButton = New-Object Windows.Forms.Button
$checkButton.Text = '检查来源'
$checkButton.SetBounds(22, 466, 100, 36)
$applyButton = New-Object Windows.Forms.Button
$applyButton.Text = '生成副本'
$applyButton.SetBounds(134, 466, 100, 36)
$applyButton.Enabled = $false
$openButton = New-Object Windows.Forms.Button
$openButton.Text = '打开副本目录'
$openButton.SetBounds(378, 466, 130, 36)
$openButton.Enabled = $false
$restoreButton = New-Object Windows.Forms.Button
$restoreButton.Text = '原位回滚'
$restoreButton.SetBounds(246, 466, 120, 36)
$restoreButton.Enabled = $false
$form.Controls.AddRange(@($checkButton, $applyButton, $restoreButton, $openButton))

$status = New-Object Windows.Forms.Label
$status.Text = '请选择来源安装目录，然后检查。'
$status.SetBounds(22, 518, 675, 27)
$form.Controls.Add($status)
$details = New-Object Windows.Forms.TextBox
$details.Multiline = $true
$details.ReadOnly = $true
$details.ScrollBars = 'Vertical'
$details.SetBounds(22, 551, 675, 171)
$details.Text = "生成期间可以继续使用当前 Codex；不要同时更新来源安装。`r`n副本包含完整运行资源，另占一份安装的磁盘空间。`r`n生成后不会自动启动或替换原版入口。"
$form.Controls.Add($details)
$note = New-Object Windows.Forms.Label
$note.Text = '实验工具，需要 Node.js 20+。原位升级/回滚前须完全退出 Codex。'
$note.SetBounds(22, 748, 675, 28)
$form.Controls.Add($note)

$script:worker = $null
$script:operation = ''
$script:operationClock = [Diagnostics.Stopwatch]::new()
$script:operationStatus = ''
$script:smokeExit = 1
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200

function Reset-Mode {
    $inplace = $modeBox.SelectedIndex -eq 1
    $applyButton.Text = if ($inplace) { '原位升级' } else { '生成副本' }
    $description.Text = if ($inplace) { '配套替换 EXE/ASAR；连续升级复用最初备份，保留现有启动方式。' } else { '仅写入新目录，不修改来源安装；支持从已原位升级的安装生成副本。' }
    $outputPath.Enabled = -not $inplace; $outputBrowse.Enabled = -not $inplace
    $restoreButton.Visible = $inplace; $openButton.Visible = -not $inplace
    $applyButton.Enabled = -not [string]::IsNullOrWhiteSpace($location.Text); $restoreButton.Enabled = $false; $openButton.Enabled = $false
    $status.Text = '选择参数后可直接执行，也可先检查来源。'
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
        if ($Command -ne 'restore') {
            $ids = @($optionList.CheckedIndices | ForEach-Object { $optionDefinitions[$_].id })
            $selection = if ($ids.Count -eq 0) { 'none' } else { $ids -join ',' }
            $info.Arguments += ' --options=' + $selection
            $info.Arguments += ' --inactive-minutes=' + [int]$retentionMinutes.Value
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
        foreach ($control in @($modeBox, $optionList, $retentionMinutes, $location, $browse, $outputPath, $outputBrowse, $checkButton, $applyButton, $restoreButton, $openButton)) { $control.Enabled = $false }
        $status.Text = @{ inspect = '正在检查来源…'; create = '正在检查来源、生成并校验副本…'; apply = '正在检查所选优化并原位升级…'; restore = '正在校验并恢复最初基线备份…' }[$Command]
        $script:operationStatus = $status.Text
        $script:operationClock.Restart()
        $details.Text = '正在校验安装文件并计算所选补丁。真实安装包较大，可能需要数分钟；完成后会显示结果。'
        $timer.Start()
    } catch {
        $status.Text = '未执行操作'
        $details.Text = $_.Exception.Message
        if ($SmokeTest) { [Console]::Error.WriteLine($_.Exception.Message); $form.Close() }
    }
}

$timer.Add_Tick({
    if ($null -eq $script:worker) { return }
    if (-not $script:worker.HasExited) {
        $status.Text = $script:operationStatus + ' 已用时 ' + [int]$script:operationClock.Elapsed.TotalSeconds + ' 秒'
        return
    }
    $script:operationClock.Stop()
    $timer.Stop()
    try {
        $output = $script:stdoutTask.Result
        $errorText = $script:stderrTask.Result
        if ($script:worker.ExitCode -ne 0) {
            $reason = if ([string]::IsNullOrWhiteSpace($errorText)) { '后台进程未返回错误说明。' } else { $errorText.Trim() }
            throw ('退出码 ' + $script:worker.ExitCode + '：' + $reason)
        }
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
                $applyButton.Enabled = $result.state -in @('ready','patched','upgraded') -and -not $result.matchesSelection
                $required = [math]::Round($result.requiredFreeBytes / 1GB, 2)
                $free = [math]::Round($result.freeBytes / 1GB, 2)
                if ($result.state -eq 'partial') { $status.Text = '检测到半完成替换，请保持 Codex 关闭并原位回滚' }
                elseif ($result.status -eq 'upgrade-applied') { $status.Text = '补丁应用成功，已完成文件校验，可按原方式启动 Codex' }
                elseif ($result.status -eq 'upgrade-restored') { $status.Text = '回滚成功，已恢复最初基线备份' }
                elseif ($result.state -eq 'upgraded') { $status.Text = if ($result.matchesSelection) { '当前安装与所选优化一致，可按原方式启动' } else { '可直接升级为所选优化，复用最初配套备份' } }
                elseif ($result.matchesSelection) { $status.Text = '所选优化已满足，无需替换文件' }
                else { $status.Text = '检查通过，退出 Codex 后可原位升级' }
                if ($result.status -eq 'upgrade-applied') {
                    $details.Text = "应用版本：$($result.version)`r`n结果：安装文件已与所选优化一致，校验通过。`r`n基线 ASAR 备份：$($result.backup)`r`n基线 EXE 备份：$($result.exeBackup)`r`n现在可以按原方式启动 Codex；后续升级继续复用这组备份。"
                } elseif ($result.status -eq 'upgrade-restored') {
                    $details.Text = "应用版本：$($result.version)`r`n结果：EXE 和 ASAR 已恢复至基线，校验通过。`r`n基线 ASAR 备份：$($result.backup)`r`n基线 EXE 备份：$($result.exeBackup)`r`n现在可以按原方式启动 Codex。"
                } else {
                    $details.Text = "应用版本：$($result.version)`r`n本次准备约需 $required GiB 可用空间，当前可用 $free GiB。`r`n回滚备份：$($result.backup)`r`nEXE 备份：$($result.exeBackup)`r`n升级和回滚同时处理两个文件；不会自动关闭或启动 Codex。"
                }
            }
            default { throw '工具返回了未知状态，请检查补丁文件是否完整。' }
        }
        $names = @($optionDefinitions | Where-Object { $result.selectedOptions -contains $_.id } | ForEach-Object { $_.label })
        $summary = if ($names.Count) { $names -join '、' } else { '不新增优化' }
        if ($result.status -ne 'upgrade-restored') {
            $selectionLabel = if ($result.status -in @('upgrade-applied','copy-created')) { '已应用优化' } else { '所选优化' }
            $details.Text += "`r`n${selectionLabel}：$summary"
            if ($result.selectedOptions -contains 'inactive-thread-unsubscribe') { $details.Text += "`r`n非活跃会话保留：$($result.inactiveMinutes) 分钟；到期后按原有安全检查取消订阅。" }
        }
        if ($SmokeTest) {
            [Console]::WriteLine((@{ status = $result.status; itemCount = $optionList.Items.Count; checkedCount = $optionList.CheckedItems.Count; selectedOptions = $result.selectedOptions } | ConvertTo-Json -Compress))
        }
        if ($result.launcher -and $result.status -ne 'upgrade-restored') { $details.Text += "`r`n专用启动入口：$($result.launcher)" }
        if ($result.status -ne 'upgrade-restored' -and $result.launchArguments -contains '--disable-features=NonBlockingOsClipboardReads') { $details.Text += "`r`n已启用剪贴板兼容参数，仅通过专用入口启动时生效。" }
        $script:smokeExit = 0
    } catch {
        $status.Text = '操作未完成'
        if ($SmokeTest) { [Console]::Error.WriteLine($_.Exception.Message) }
        $details.Text = $_.Exception.Message + "`r`n请处理上述原因后重试。若提示访问被拒绝，请确认目录权限。"
        $applyButton.Enabled = -not [string]::IsNullOrWhiteSpace($location.Text)
    } finally {
        $script:worker.Dispose()
        $script:worker = $null
        $location.Enabled = $true; $browse.Enabled = $true; $checkButton.Enabled = $true
        $modeBox.Enabled = $true; $optionList.Enabled = $true
        $retentionMinutes.Enabled = $optionList.GetItemChecked($retentionIndex)
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
$optionList.Add_ItemCheck({
    param($sender, $eventArgs)
    # 控件刷新可能发出值未变化的 ItemCheck；操作期间也不能覆盖完成结果。
    if ($eventArgs.NewValue -eq $eventArgs.CurrentValue -or $null -ne $script:worker) { return }
    if ($eventArgs.Index -eq $retentionIndex) { $retentionMinutes.Enabled = $eventArgs.NewValue -eq [Windows.Forms.CheckState]::Checked }
    $applyButton.Enabled = -not [string]::IsNullOrWhiteSpace($location.Text); $openButton.Enabled = $false
    $status.Text = '勾选已更新，可直接执行；执行时自动校验，无需重新检查。'
    $details.Text = '待执行：按当前勾选应用优化。回滚仍恢复最初基线备份。'
})
$retentionMinutes.Add_ValueChanged({
    if ($null -ne $script:worker) { return }
    $applyButton.Enabled = -not [string]::IsNullOrWhiteSpace($location.Text); $openButton.Enabled = $false
    $status.Text = '保留时间已更新，可直接执行，无需重新检查。'
    $details.Text = "待执行：非活跃会话保留 $([int]$retentionMinutes.Value) 分钟。仅在勾选会话取消订阅优化时生效。"
})
$location.Add_TextChanged({ $applyButton.Enabled = $null -eq $script:worker -and -not [string]::IsNullOrWhiteSpace($location.Text); $restoreButton.Enabled = $false; $openButton.Enabled = $false })
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
    # 启动时读取既有安装的时限；显式命令行参数优先，回滚仍只使用安装记录。
    if ($location.Text -and -not $script:inactiveMinutesExplicit) {
        try {
            $recordPath = Join-Path (Split-Path (Split-Path (Resolve-Asar $location.Text) -Parent) -Parent) 'codex-lite-install.json'
            if (Test-Path -LiteralPath $recordPath) {
                $saved = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($null -ne $saved.inactiveMinutes -and $saved.inactiveMinutes -ge 1 -and $saved.inactiveMinutes -le 180 -and [int]$saved.inactiveMinutes -eq $saved.inactiveMinutes) { $retentionMinutes.Value = $saved.inactiveMinutes }
            }
        } catch { $details.Text = '安装记录读取失败；执行时会重新校验。' }
    }
    if ($location.Text) { Start-Operation 'inspect' }
    elseif ($SmokeTest) { $form.Close() }
})
if ($SmokeTest) { $form.ShowInTaskbar = $false; $form.Opacity = 0 }
[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
if ($SmokeTest) { exit $script:smokeExit }
