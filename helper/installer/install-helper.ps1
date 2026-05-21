# Installs Access-To-Power Helper for the current Windows user.
#
# This is intentionally HKCU/per-user: no admin rights are required, and the
# installer can be distributed as a zip created by scripts/package-helper-installer.ps1.

[CmdletBinding()]
param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "AccessToPower\Helper"),
    [switch]$SkipAceCheck
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-AceProvider {
    $providerKeys = @(
        "HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.16.0",
        "HKCU:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.16.0",
        "HKLM:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.12.0",
        "HKCU:\SOFTWARE\Classes\Microsoft.ACE.OLEDB.12.0",
        "HKLM:\SOFTWARE\WOW6432Node\Classes\Microsoft.ACE.OLEDB.16.0",
        "HKLM:\SOFTWARE\WOW6432Node\Classes\Microsoft.ACE.OLEDB.12.0"
    )
    foreach ($key in $providerKeys) {
        if (Test-Path $key) { return $true }
    }
    return $false
}

function Set-ProtocolHandler([string]$ExePath) {
    $key = "HKCU:\Software\Classes\accesstopower"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value "URL:Access to Power Helper Protocol"
    Set-ItemProperty -Path $key -Name "URL Protocol" -Value ""

    $iconKey = Join-Path $key "DefaultIcon"
    New-Item -Path $iconKey -Force | Out-Null
    Set-ItemProperty -Path $iconKey -Name "(default)" -Value "`"$ExePath`",0"

    $cmdKey = Join-Path $key "shell\open\command"
    New-Item -Path $cmdKey -Force | Out-Null
    Set-ItemProperty -Path $cmdKey -Name "(default)" -Value "`"$ExePath`" `"%1`""
}

function Set-UninstallEntry([string]$InstallPath, [string]$ExePath, [string]$Version) {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AccessToPowerHelper"
    $uninstallCommand = "powershell.exe -ExecutionPolicy Bypass -File `"$InstallPath\uninstall-helper.ps1`""

    New-Item -Path $uninstallKey -Force | Out-Null
    Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "Access-To-Power Helper"
    Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value $Version
    Set-ItemProperty -Path $uninstallKey -Name "Publisher" -Value "Access to Power"
    Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $InstallPath
    Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon" -Value "$ExePath,0"
    Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value $uninstallCommand
    Set-ItemProperty -Path $uninstallKey -Name "NoModify" -Value 1 -Type DWord
    Set-ItemProperty -Path $uninstallKey -Name "NoRepair" -Value 1 -Type DWord
}

$SourceDir = (Resolve-Path $SourceDir).Path
$sourceExe = Join-Path $SourceDir "AccessToPowerHelper.exe"
if (-not (Test-Path $sourceExe)) {
    throw "AccessToPowerHelper.exe was not found in $SourceDir. Run scripts/package-helper-installer.ps1 first, or pass -SourceDir to the published helper folder."
}

if (-not $SkipAceCheck -and -not (Test-AceProvider)) {
    Write-Host "WARNING: Microsoft ACE OLEDB provider was not detected." -ForegroundColor Yellow
    Write-Host "Install the 64-bit Microsoft Access Database Engine before scanning .accdb/.mdb files." -ForegroundColor Yellow
}

Write-Step "Installing helper to $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

$installedExe = Join-Path $InstallDir "AccessToPowerHelper.exe"
if (-not (Test-Path $installedExe)) {
    throw "Install failed: $installedExe was not copied."
}

$versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($installedExe)
$version = if ($versionInfo.ProductVersion) { $versionInfo.ProductVersion } else { "0.1.0" }

Write-Step "Registering accesstopower:// protocol"
Set-ProtocolHandler $installedExe

Write-Step "Registering uninstall entry"
Set-UninstallEntry $InstallDir $installedExe $version

$installInfo = [ordered]@{
    product = "Access-To-Power Helper"
    version = $version
    installedAt = [DateTimeOffset]::UtcNow.ToString("O")
    installDir = $InstallDir
    exePath = $installedExe
    protocol = "accesstopower"
}
$installInfo | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir "install-info.json") -Encoding UTF8

Write-Host ""
Write-Host "Access-To-Power Helper installed successfully." -ForegroundColor Green
Write-Host "Protocol: accesstopower://"
Write-Host "Executable: $installedExe"