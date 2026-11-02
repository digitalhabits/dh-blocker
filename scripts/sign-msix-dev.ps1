# Sign a local Store (MSIX) build for sideload testing.
#
# Partner Center re-signs on upload; build:win-store leaves the .msix unsigned.
# Local install needs: elevated PowerShell, dev cert matching WINDOWS_PUBLISHER,
# cert in LocalMachine\TrustedPeople, and Appx sideload policy enabled.
#
# Usage (run PowerShell as Administrator for -Install):
#   .\scripts\sign-msix-dev.ps1 -MsixPath "for-distribution\aarch64-pc-windows-msvc\Digital-Habits-Blocker_3.1.5.0_arm64.msix" -Install

param(
    [Parameter(Mandatory = $true)]
    [string]$MsixPath,
    [switch]$Install,
    [switch]$LocalTest
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MsixPath = if ([System.IO.Path]::IsPathRooted($MsixPath)) { $MsixPath } else { Join-Path $ProjectRoot $MsixPath }

if (-not (Test-Path $MsixPath)) {
    Write-Host "ERROR: MSIX not found: $MsixPath" -ForegroundColor Red
    exit 1
}

function Test-IsAdmin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator
    )
}

function Enable-AppxDevSideloadPolicy {
    $unlock = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
    if (-not (Test-Path $unlock)) {
        New-Item -Path $unlock -Force | Out-Null
    }
    Set-ItemProperty -Path $unlock -Name AllowDevelopmentWithoutDevLicense -Value 1 -Type DWord -Force
    Set-ItemProperty -Path $unlock -Name AllowAllTrustedApps -Value 1 -Type DWord -Force
    Write-Host "  Enabled Appx dev sideload policy (AppModelUnlock)" -ForegroundColor Gray
}

function Import-CertToTrustedPeople {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )
    $cerPath = Join-Path $env:TEMP "redd-block-msix-signer.cer"
    Export-Certificate -Cert $Certificate -FilePath $cerPath -Force | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPeople" -ErrorAction Stop | Out-Null
    Write-Host "  Trusted signer in LocalMachine\TrustedPeople" -ForegroundColor Gray
}

$envFile = Join-Path $ProjectRoot ".env"
if (-not $LocalTest -and (Test-Path $envFile)) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim().Trim('"').Trim("'")
                [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
            }
        }
    }
}

$Publisher = $env:WINDOWS_PUBLISHER
if ($LocalTest) { $Publisher = "CN=Digital Habits Local Test" }
if (-not $Publisher) {
    Write-Host "ERROR: Set WINDOWS_PUBLISHER in .env (Partner Center product identity)." -ForegroundColor Red
    exit 1
}

if ($Install -and -not (Test-IsAdmin)) {
    Write-Host "ERROR: -Install requires PowerShell run as Administrator." -ForegroundColor Red
    Write-Host "  Appx only trusts dev certs in LocalMachine\TrustedPeople (not CurrentUser)." -ForegroundColor Yellow
    exit 1
}

$signtool = $env:TAURI_WINDOWS_SIGNTOOL_PATH
if (-not $signtool -or -not (Test-Path $signtool)) {
    $signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
}
if (-not $signtool) {
    Write-Host "ERROR: signtool.exe not found. Install the Windows SDK." -ForegroundColor Red
    exit 1
}

Write-Host "=== Sign MSIX for local sideload ===" -ForegroundColor Cyan
Write-Host "  Package: $MsixPath" -ForegroundColor Gray
Write-Host "  Publisher (cert subject): $Publisher" -ForegroundColor Gray
Write-Host "  SignTool: $($signtool.FullName)" -ForegroundColor Gray
Write-Host ""

if ($Install) {
    Enable-AppxDevSideloadPolicy
}

# Sign with CurrentUser\My (signtool default). Trust for install uses LocalMachine\TrustedPeople.
$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Publisher } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

if (-not $cert) {
    Write-Host "  Creating dev code-signing cert in CurrentUser\My..." -ForegroundColor Gray
    $cert = New-SelfSignedCertificate `
        -Type Custom `
        -Subject $Publisher `
        -KeyUsage DigitalSignature `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -FriendlyName "Digital Habits Blocker MSIX local dev" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @(
            "2.5.29.37={text}1.3.6.1.5.5.7.3.3",
            "2.5.29.19={text}FALSE"
        )
}

Write-Host "  Dev cert thumbprint: $($cert.Thumbprint)" -ForegroundColor Gray

# signtool remove does not support .msix (only portable executables). Re-sign in place,
# or rebuild with `pnpm build:win-store` if a prior dev signature causes trouble.
Write-Host "  Signing..." -ForegroundColor Gray
& $signtool.FullName sign /fd SHA256 /sha1 $cert.Thumbprint $MsixPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: signtool sign failed (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}
Write-Host "  Signed OK." -ForegroundColor Green

$sig = Get-AuthenticodeSignature -FilePath $MsixPath
Write-Host "  Signature status: $($sig.Status)" -ForegroundColor Gray
if (-not $sig.SignerCertificate) {
    Write-Host "ERROR: Package has no signer certificate after signing." -ForegroundColor Red
    exit 1
}

if ($Install) {
    Import-CertToTrustedPeople -Certificate $sig.SignerCertificate

    Write-Host "  Installing..." -ForegroundColor Gray
    Add-AppxPackage -Path $MsixPath -ForceUpdateFromAnyVersion
    $label = if ($LocalTest) { 'the app ending in (Test)' } else { 'Digital Habits: Blocker' }
    Write-Host "  Installed. Launch $label from the Start menu." -ForegroundColor Green
    Write-Host "  (Also enable Settings > System > For developers > Developer Mode if install still fails.)" -ForegroundColor Gray
} else {
    Write-Host ""
    Write-Host "Sign-only done. To install, re-run as Administrator with -Install:" -ForegroundColor Yellow
    $testFlag = if ($LocalTest) { ' -LocalTest' } else { '' }
    Write-Host "  .\scripts\sign-msix-dev.ps1 -MsixPath `"$MsixPath`" -Install$testFlag" -ForegroundColor White
}
