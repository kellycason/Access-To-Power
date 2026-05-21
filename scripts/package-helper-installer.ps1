# Builds a distributable Access-To-Power Helper zip.
#
# The zip is intended to be signed/hosted outside the Power Platform solution
# (for example in an internal software portal, Azure Blob, Intune, or GitHub
# release). Configure the Code App with VITE_HELPER_INSTALLER_URL to point at it.

[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64",
    [string]$Version = "0.1.0",
    [string]$OutputDir,
    [switch]$FrameworkDependent,
    [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"

$scriptRoot = if ($PSScriptRoot) {
    $PSScriptRoot
} elseif ($PSCommandPath) {
    Split-Path -Parent $PSCommandPath
} else {
    Join-Path (Get-Location).Path "scripts"
}

if (-not $OutputDir) {
    $OutputDir = Join-Path $scriptRoot "..\artifacts"
}

$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$helperProject = Join-Path $repoRoot "helper\AccessToPower.Helper.csproj"
$stageRoot = Join-Path $OutputDir "helper-installer"
$stageDir = Join-Path $stageRoot "AccessToPowerHelper"
$zipPath = Join-Path $OutputDir "AccessToPowerHelper-$Version-$Runtime.zip"
$fileVersion = if ($Version -match '^\d+\.\d+\.\d+\.\d+$') {
    $Version
} elseif ($Version -match '^\d+\.\d+\.\d+$') {
    "$Version.0"
} else {
    "0.1.0.0"
}

if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$publishArgs = @(
    "publish", $helperProject,
    "-c", $Configuration,
    "-r", $Runtime,
    "-p:Version=$Version",
    "-p:FileVersion=$fileVersion"
)
if ($FrameworkDependent) {
    $publishArgs += @("--self-contained", "false")
} else {
    $publishArgs += @("--self-contained", "true")
}

Write-Host "Publishing helper..." -ForegroundColor Cyan
dotnet @publishArgs | Write-Host

$publishDir = Join-Path $repoRoot "helper\bin\$Configuration\net10.0-windows\$Runtime\publish"
if (-not (Test-Path (Join-Path $publishDir "AccessToPowerHelper.exe"))) {
    throw "Published helper executable was not found at $publishDir"
}

Write-Host "Staging installer package..." -ForegroundColor Cyan
Copy-Item -Path (Join-Path $publishDir "*") -Destination $stageDir -Recurse -Force
Copy-Item -Path (Join-Path $repoRoot "helper\installer\install-helper.ps1") -Destination $stageDir -Force
Copy-Item -Path (Join-Path $repoRoot "helper\installer\uninstall-helper.ps1") -Destination $stageDir -Force
Copy-Item -Path (Join-Path $repoRoot "helper\installer\README.md") -Destination $stageDir -Force

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Write-Host "Creating $zipPath..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

if (-not $KeepStaging) {
    Remove-Item $stageRoot -Recurse -Force
}

Write-Host ""
Write-Host "Helper installer package created:" -ForegroundColor Green
Write-Host "  $zipPath"
Write-Host ""
Write-Host "Host this zip and set VITE_HELPER_INSTALLER_URL to its download URL before building/pushing the Code App."
