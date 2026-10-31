#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Distribution = 'Ubuntu-24.04',
    [string]$LinuxNode,
    [string]$Image = 'ds-bot-cua-probe:0.37.0',
    [string[]]$UpgradeImages = @(),
    [string]$DataRoot = (Join-Path $PSScriptRoot '.dsh-test-cua-desktop'),
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
function Invoke-Wsl {
    param([string[]]$Arguments)
    $result = & wsl.exe --distribution $Distribution --exec @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'The WSL Computer preflight failed. Check the distribution, Docker and desktop image.' }
    return ($result -join "`n").Trim()
}
if ($Distribution -notmatch '^[a-zA-Z0-9][\w.-]{0,79}$') { throw 'Use a WSL distribution name.' }
# A login shell started with --exec does not load nvm, so `node` is often missing
# even when Node 22 is installed under ~/.nvm. Pick the newest of those builds.
if (-not $LinuxNode) {
    $LinuxNode = Invoke-Wsl @('/bin/bash', '-lc', 'if p=$(command -v node); then printf %s "$p"; else ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -V | tail -n 1 || true; fi')
}
if (-not $LinuxNode.StartsWith('/')) { throw 'Pass -LinuxNode with the absolute Linux Node.js path.' }
$version = Invoke-Wsl @($LinuxNode, '-p', 'process.versions.node')
if ([int]($version.Split('.')[0]) -lt 22) { throw 'The WSL Broker requires Node.js 22 or newer.' }
$entry = Invoke-Wsl @('wslpath', '-a', '-u', (Join-Path $PSScriptRoot 'computer-runtime\broker\main.mjs'))
$imageId = Invoke-Wsl @('docker', 'image', 'inspect', $Image, '--format', '{{.Id}}')
if ($imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Build the desktop image first; see computer-runtime/README.md.' }
$runtimeCheck = Invoke-Wsl @('wslpath', '-a', '-u', (Join-Path $PSScriptRoot 'computer-runtime\runtime.mjs'))
$null = Invoke-Wsl @($LinuxNode, $runtimeCheck, 'check', $imageId)
if ($UpgradeImages.Count -gt 4) { throw 'Pass at most four upgrade images in oldest-to-newest order.' }
$upgradeIds = @()
foreach ($candidate in $UpgradeImages) {
    $candidateId = Invoke-Wsl @('docker', 'image', 'inspect', $candidate, '--format', '{{.Id}}')
    if ($candidateId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Each upgrade image must already be installed in the configured WSL runtime.' }
    $null = Invoke-Wsl @($LinuxNode, $runtimeCheck, 'check', $candidateId)
    if ($candidateId -ne $imageId -and $candidateId -notin $upgradeIds) { $upgradeIds += $candidateId }
}
if (-not [IO.Path]::IsPathRooted($DataRoot)) { $DataRoot = Join-Path $PSScriptRoot $DataRoot }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
[void][IO.Directory]::CreateDirectory($DataRoot)
$configFile = Join-Path $DataRoot 'computer.json'
$config = @{ enabled = $true; broker = @{ entrypoint = $entry; image = $imageId; images = $upgradeIds; wsl = @{ distribution = $Distribution; node = $LinuxNode } } }
[IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
$previous = $env:DS_BOT_COMPUTER_CONFIG
try {
    $env:DS_BOT_COMPUTER_CONFIG = $configFile
    & (Join-Path $PSScriptRoot 'start.ps1') -DataRoot $DataRoot -PrepareOnly:$PrepareOnly
} finally {
    if ($null -eq $previous) { Remove-Item Env:DS_BOT_COMPUTER_CONFIG -ErrorAction SilentlyContinue }
    else { $env:DS_BOT_COMPUTER_CONFIG = $previous }
}
