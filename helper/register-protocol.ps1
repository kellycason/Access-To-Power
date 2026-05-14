# Registers (or removes) the accesstopower:// protocol handler in HKCU.
# HKCU = no admin required. Run AFTER you've built or published the helper.
#
# Usage:
#   .\register-protocol.ps1                                    # uses .\bin\Release\net10.0-windows\AccessToPowerHelper.exe
#   .\register-protocol.ps1 -ExePath C:\full\path\to\helper.exe
#   .\register-protocol.ps1 -Unregister

[CmdletBinding()]
param(
    [string]$ExePath,
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$key = "HKCU:\Software\Classes\accesstopower"

if ($Unregister) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force
        Write-Host "Unregistered accesstopower:// protocol handler."
    } else {
        Write-Host "Protocol handler was not registered."
    }
    return
}

if (-not $ExePath) {
    $ExePath = Join-Path $PSScriptRoot "bin\Release\net10.0-windows\win-x64\AccessToPowerHelper.exe"
}
if (-not (Test-Path $ExePath)) {
    throw "Helper executable not found at: $ExePath. Build the helper first with 'dotnet publish -c Release'."
}
$ExePath = (Resolve-Path $ExePath).Path

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value "URL:Access to Power Helper Protocol"
Set-ItemProperty -Path $key -Name "URL Protocol" -Value ""

$iconKey = Join-Path $key "DefaultIcon"
New-Item -Path $iconKey -Force | Out-Null
Set-ItemProperty -Path $iconKey -Name "(default)" -Value "`"$ExePath`",0"

$cmdKey = Join-Path $key "shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
Set-ItemProperty -Path $cmdKey -Name "(default)" -Value "`"$ExePath`" `"%1`""

Write-Host "Registered accesstopower:// -> $ExePath"
Write-Host "Test with: Start-Process 'accesstopower://launch?jobId=00000000-0000-0000-0000-000000000001&env=https://yourorg.crm.dynamics.com&tenant=00000000-0000-0000-0000-000000000000&name=Test'"
