[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $DatabaseName,
  [switch] $Remote
)

$ErrorActionPreference = 'Stop'
$migrationRoot = Join-Path $PSScriptRoot '../../infra/migrations' | Resolve-Path
$files = Get-ChildItem -LiteralPath $migrationRoot -Filter '*.sql' | Sort-Object Name
if ($files.Count -ne 15) { throw "Expected exactly 15 MVP1 migrations, found $($files.Count)" }

foreach ($file in $files) {
  Write-Host "Applying $($file.Name)"
  $args = @('d1', 'execute', $DatabaseName, '--file', $file.FullName)
  if ($Remote) { $args += '--remote' }
  & npx wrangler @args
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($file.Name)" }
}
