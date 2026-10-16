$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Get-Content -LiteralPath (Join-Path $root 'launcher.ps1') -Raw -Encoding UTF8
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
function Assert-Ui($condition, [string]$message) { if (-not $condition) { throw $message } }
function Handler([string]$name) {
    $node = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq $name }, $true))
    Assert-Ui ($node.Count -eq 1) "事件应唯一：$name"
    return $node[0].Arguments[0].ScriptBlock.GetScriptBlock()
}
# 创建真实 WinForms 控件与事件，但不显示窗口、不启动 Node 后端或修改安装。
$prefix = $source.Substring(0, $source.IndexOf('[void]$form.ShowDialog()'))
$prefix = $prefix.Replace('$PSScriptRoot', ("'" + $root.Replace("'", "''") + "'"))
Invoke-Expression $prefix
try {
    $location.Text = 'C:\Example\Codex\resources\app.asar'
    $modeBox.SelectedIndex = 1
    Assert-Ui $applyButton.Enabled '选好来源与模式后应能直接执行'
    $optionList.SetItemChecked(0, $false)
    Assert-Ui $applyButton.Enabled '修改勾选后不应要求手动检查'
    Assert-Ui ($status.Text -like '*无需重新检查*') '应说明执行时自动校验'

    $tick = Handler 'Add_Tick'
    $itemCheck = Handler 'Add_ItemCheck'
    foreach ($completion in @('upgrade-applied', 'upgrade-restored', 'copy-created')) {
        $script:worker = [pscustomobject]@{ HasExited = $true; ExitCode = 0 }
        $script:worker | Add-Member ScriptMethod Dispose {}
        $payload = @{ status = $completion; state = 'upgraded'; canRestore = $true; matchesSelection = $true;
            version = '26.928.20755'; requiredFreeBytes = 123; freeBytes = 456;
            backup = 'baseline.asar'; exeBackup = 'baseline.exe'; selectedOptions = @('menu');
            output = 'C:\Example\Copy'; launcher = 'C:\Example\Copy\启动优化版.cmd' }
        $script:stdoutTask = [pscustomobject]@{ Result = ($payload | ConvertTo-Json -Compress) }
        $script:stderrTask = [pscustomobject]@{ Result = '' }
        $optionList.Enabled = $false
        & $tick
        Assert-Ui ($null -eq $script:worker) '完成后应释放 worker'
        Assert-Ui ($status.Text -match '成功|已生成') "完成后应明确提示成功：$completion"
        Assert-Ui ($details.Text -notmatch '本次准备约需') '成功后不应保留执行前的空间估算'
        if ($completion -eq 'upgrade-restored') {
            Assert-Ui ($details.Text -notmatch '已应用优化|所选优化') '回滚后不能把原勾选误称为当前优化'
        } else { Assert-Ui ($details.Text -match '已应用优化') '成功后应展示已应用的优化' }
        $success = $status.Text
        & $itemCheck $optionList ([Windows.Forms.ItemCheckEventArgs]::new(0, [Windows.Forms.CheckState]::Unchecked, [Windows.Forms.CheckState]::Unchecked))
        Assert-Ui ($status.Text -eq $success) '值未变化的 ItemCheck 不能覆盖成功结果'
    }
    $optionList.SetItemChecked(0, $true)
    Assert-Ui $applyButton.Enabled '成功后更换选项应能再次执行'
    $location.Text = ''
    Assert-Ui (-not $applyButton.Enabled) '空路径不能执行'
    Write-Output 'PASS: direct execution, option changes, apply/restore/copy completion, and unchanged ItemCheck events.'
} finally {
    $timer.Dispose(); $form.Dispose()
}
