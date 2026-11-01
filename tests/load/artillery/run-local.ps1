param(
  [ValidateSet('1','25','50')]
  [string]$Stage = '1'
)

$ErrorActionPreference = 'Stop'
$profiles = @{
  '1' = @{ Loops = 1; Think = '1'; Offset = 120 }
  '25' = @{ Loops = 27; Think = '11.1'; Offset = 180 }
  '50' = @{ Loops = 27; Think = '11.1'; Offset = 240 }
}
$profile = $profiles[$Stage]
$env:MF_ARTILLERY_SLOT_OFFSET = [string]$profile.Offset
$env:MF_ARTILLERY_THINK_SECONDS = [string]$profile.Think
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$reports = Join-Path $root 'reports'
New-Item -ItemType Directory -Path $reports -Force | Out-Null
$template = Get-Content (Join-Path $root 'local-booking.template.yml') -Raw
$config = $template.Replace('__VUS__', $Stage).Replace('__LOOPS__', [string]$profile.Loops)
$generated = Join-Path $reports "journey-$Stage.generated.yml"
$report = Join-Path $reports "journey-$Stage.json"
Set-Content -LiteralPath $generated -Value $config -Encoding utf8
& (Join-Path $PSScriptRoot '..\..\..\node_modules\.bin\artillery.cmd') run --output $report $generated
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
