# CoLive Two-Window Dev Script (PowerShell)
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$DevDir = Join-Path $RootDir ".dev"
$SampleDir = Join-Path $DevDir "sample-workspace"
$HostData = Join-Path $DevDir "host-user-data"
$HostExt = Join-Path $DevDir "host-extensions"
$GuestData = Join-Path $DevDir "guest-user-data"
$GuestExt = Join-Path $DevDir "guest-extensions"

$EditorBin = $env:EDITOR_BIN
if (-not $EditorBin) {
    if (Get-Command antigravity -ErrorAction SilentlyContinue) {
        $EditorBin = "antigravity"
    } elseif (Get-Command code -ErrorAction SilentlyContinue) {
        $EditorBin = "code"
    } else {
        Write-Error "Neither 'antigravity' nor 'code' found in PATH."
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path (Join-Path $SampleDir "src") | Out-Null
New-Item -ItemType Directory -Force -Path $HostData, $HostExt, $GuestData, $GuestExt | Out-Null

Set-Content -Path (Join-Path $SampleDir "src\index.ts") -Value "export function greet(name: string) { return 'Hello ' + name; }"
Set-Content -Path (Join-Path $SampleDir ".env") -Value "SECRET=supersecret_api_key_123"

Write-Host "==> Starting build..."
npm run build

Write-Host "==> Launching Host window..."
Start-Process $EditorBin -ArgumentList "--user-data-dir `"$HostData`"", "--extensions-dir `"$HostExt`"", "--extensionDevelopmentPath=`"$RootDir\packages\extension`"", "`"$SampleDir`""

Write-Host "==> Launching Guest window..."
Start-Process $EditorBin -ArgumentList "--user-data-dir `"$GuestData`"", "--extensions-dir `"$GuestExt`"", "--extensionDevelopmentPath=`"$RootDir\packages\extension`""
