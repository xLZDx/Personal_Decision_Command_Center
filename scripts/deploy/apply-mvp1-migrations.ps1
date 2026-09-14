[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $DatabaseName,
  [switch] $Remote
)

$ErrorActionPreference = 'Stop'
$migrationRoot = Join-Path $PSScriptRoot '../../infra/migrations' | Resolve-Path
$files = Get-ChildItem -LiteralPath $migrationRoot -Filter '*.sql' | Sort-Object Name
if ($files.Count -ne 15) { throw "Expected exactly 15 MVP1 migrations, found $($files.Count)" }
$args = @('wrangler', 'd1', 'migrations', 'apply', $DatabaseName, '--config', 'infra/cloudflare/ingest.wrangler.toml')
if ($Remote) { $args += '--remote' } else { $args += '--local' }
Write-Host "Applying $($files.Count) migrations through Wrangler's d1_migrations ledger"
& npx @args
if ($LASTEXITCODE -ne 0) { throw 'MVP1 migration apply failed; inspect Wrangler output and rerun safely' }
