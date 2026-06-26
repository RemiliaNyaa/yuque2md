$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

# 结果输出文件
$resultFile = Join-Path $env:TEMP "yq_fp_result.txt"

# 编译 C# 文件
$csFile = Join-Path $PSScriptRoot "FolderPicker.cs"
Add-Type -Path $csFile | Out-Null

# 获取桌面路径
$desktop = [Environment]::GetFolderPath("Desktop")

# 显示文件夹选择对话框
try {
    $path = [FolderPicker.Dialog]::PickFolder("浏览", $desktop)
    if ($path) {
        [System.IO.File]::WriteAllText($resultFile, "OK:$path", [System.Text.Encoding]::UTF8)
    } else {
        [System.IO.File]::WriteAllText($resultFile, "CANCEL", [System.Text.Encoding]::UTF8)
    }
} catch {
    [System.IO.File]::WriteAllText($resultFile, "ERROR:$($_.Exception.Message)", [System.Text.Encoding]::UTF8)
}
