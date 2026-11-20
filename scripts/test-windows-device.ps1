[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppPath,
  [Parameter(Mandatory = $true)][string]$ChromiumPath,
  [Parameter(Mandatory = $true)][string]$CamoufoxPath,
  [string]$ReportPath = (Join-Path $env:TEMP 'cike-windows-device.json')
)

$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
if ($os.ProductType -ne 1 -or $os.Version -notlike '10.0.*' -or [int]$os.BuildNumber -lt 17134) {
  throw 'Run on a Windows 10 (1803+) or Windows 11 desktop. Windows Server is excluded.'
}
if (-not [Environment]::UserInteractive) { throw 'Run from a signed-in desktop session.' }

$inputs = @{
  CIKE_TEST_APP = $AppPath
  LFB_CHROMIUM_EXECUTABLE = $ChromiumPath
  CIKE_CAMOUFOX_EXECUTABLE = $CamoufoxPath
}
foreach ($name in @($inputs.Keys)) {
  $file = Get-Item -LiteralPath $inputs[$name]
  if ($file.PSIsContainer -or $file.Extension -ne '.exe') { throw "${name} must point to an executable file." }
  $inputs[$name] = $file.FullName
}
$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion)
$commit = $null
$previous = @{}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  if (-not (Test-Path -LiteralPath 'node_modules\playwright\package.json')) { throw 'Run npm ci in the source checkout first.' }
  if (Get-Command git -ErrorAction SilentlyContinue) { $commit = git rev-parse HEAD }
  $inputs['LFB_EXPOSE_DEBUGGER'] = $null
  $inputs['CIKE_SCREENSHOT'] = $null
  foreach ($name in $inputs.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $inputs[$name], 'Process')
  }
  $tests = @(
    'test/network.test.js', 'test/kernel-network.test.js', 'test/kernel-runtime.test.js',
    'test/kernel-startup.test.js', 'test/kernel-graphics.test.js', 'test/kernel-recovery.test.js',
    'test/windows-window.test.js', 'test/desktop.test.js'
  )
  node --test --test-concurrency=1 --test-reporter=tap @tests | Tee-Object -Variable tap
  $testExit = $LASTEXITCODE
} finally {
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  Pop-Location
}

$counts = @{}
foreach ($line in $tap) {
  if ($line -match '^# (tests|pass|fail|skipped) (\d+)$') { $counts[$Matches[1]] = [int]$Matches[2] }
}
$passed = $testExit -eq 0 -and $counts['tests'] -gt 0 -and $counts['pass'] -eq $counts['tests'] -and $counts['skipped'] -eq 0
[ordered]@{
  timestamp = [DateTime]::UtcNow.ToString('o')
  windows = @{ edition = $os.Caption; build = $os.BuildNumber }
  graphics = $gpu
  commit = $commit
  applicationVersion = (Get-Item -LiteralPath $inputs['CIKE_TEST_APP']).VersionInfo.ProductVersion
  automaticPassed = $passed
  counts = $counts
  manualChecks = 'not recorded by this script'
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "Report: $ReportPath"
if (-not $passed) { exit 1 }
