param(
  [ValidateSet('x64')]
  [string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Electron = Join-Path $Root 'electron'
$Zig = Join-Path $Root 'zig-core'

Push-Location (Join-Path $Electron 'ui')
npm ci
npm run build
Pop-Location

Push-Location $Zig
zig build -Doptimize=ReleaseSafe
Pop-Location

New-Item -ItemType Directory -Force -Path (Join-Path $Electron 'bin') | Out-Null
Copy-Item (Join-Path $Zig 'zig-out\bin\stage-shell-core.exe') (Join-Path $Electron 'bin\stage-shell-core.exe') -Force

Push-Location $Electron
npm ci
npx electron-builder --win portable --$Arch
Pop-Location

Write-Host "Portable package: $Electron\portable-release"
