param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$OutputDirectory = (Resolve-Path $OutputDirectory).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual C++ tools unavailable' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$source = Join-Path $PSScriptRoot 'native-uia.cpp'
# All compiler/linker outputs stay in the run directory. No system installation.
$build = Join-Path $OutputDirectory 'build-uia.cmd'
@"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cl /nologo /EHsc /W4 /WX "$source" /Fe:"$OutputDirectory\native-uia.exe" /Fo:"$OutputDirectory\native-uia.obj" ole32.lib oleaut32.lib user32.lib uiautomationcore.lib
"@ | Set-Content $build
& cmd.exe /d /c $build
if ($LASTEXITCODE -ne 0) { throw 'Native UIA client compilation failed' }
