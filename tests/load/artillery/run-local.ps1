param(
  [ValidateSet('1','5','10','25')]
  [string]$Stage = '1'
)

$ErrorActionPreference = 'Stop'
$loops = if ($Stage -eq '25') { 60 } else { 6 }
$slotOffsets = @{ '1' = 0; '5' = 1; '10' = 6; '25' = 41 }
$env:MF_ARTILLERY_SLOT_OFFSET = [string]$slotOffsets[$Stage]
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$reports = Join-Path $root 'reports'
New-Item -ItemType Directory -Path $reports -Force | Out-Null
$template = Get-Content (Join-Path $root 'local-booking.template.yml') -Raw
$config = $template.Replace('__VUS__', $Stage).Replace('__LOOPS__', [string]$loops)
$generated = Join-Path $reports "local-$Stage.generated.yml"
$report = Join-Path $reports "local-$Stage.json"
Set-Content -LiteralPath $generated -Value $config -Encoding utf8
& (Join-Path $PSScriptRoot '..\..\..\node_modules\.bin\artillery.cmd') run --output $report $generated
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
