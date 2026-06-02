# Uninstalls Access-To-Power Helper for the current Windows user.

[CmdletBinding()]
param(
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"

if (-not $InstallDir) {
    $InstallDir = if ($PSScriptRoot) {
        $PSScriptRoot
    } elseif ($PSCommandPath) {
        Split-Path -Parent $PSCommandPath
    } elseif ($MyInvocation.MyCommand.Path) {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        (Get-Location).Path
    }
}

$protocolKey = "HKCU:\Software\Classes\accesstopower"
if (Test-Path $protocolKey) {
    Remove-Item -Path $protocolKey -Recurse -Force
    Write-Host "Unregistered accesstopower:// protocol handler."
}

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AccessToPowerHelper"
if (Test-Path $uninstallKey) {
    Remove-Item -Path $uninstallKey -Recurse -Force
    Write-Host "Removed uninstall entry."
}

$InstallDir = (Resolve-Path $InstallDir).Path
Write-Host "Removing $InstallDir"

$cleanup = @"
Start-Sleep -Seconds 2
Remove-Item -LiteralPath '$($InstallDir.Replace("'", "''"))' -Recurse -Force -ErrorAction SilentlyContinue
"@

Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $cleanup
) -WindowStyle Hidden

Write-Host "Access-To-Power Helper uninstall started." -ForegroundColor Green