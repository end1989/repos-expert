<#
.SYNOPSIS
  One-command setup: installs what is missing, builds the tool, and connects it to
  Claude Desktop.

.DESCRIPTION
  Safe to re-run. The config and the Claude Desktop entry are written by the tool's own
  `init`, which never overwrites an existing config, keeps a backup of the Claude Desktop
  config, and reports what it did or why it skipped.

.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -ReposDir 'C:\dev\repos' -GithubUser 'your-username'
#>
[CmdletBinding()]
param(
  # Folder that holds your project folders. Defaults to the repos/ folder in this clone.
  # A relative path is read from where you run the script.
  [string] $ReposDir,
  # Optional: only needed to pull repos down from GitHub.
  [string] $GithubUser,
  # Skip editing the Claude Desktop config.
  [switch] $SkipClaudeDesktop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Keep this file ASCII. Windows PowerShell 5.1 reads a script without a byte-order mark
# as Windows-1252, where the last byte of a UTF-8 dash is a curly quote that ends a string.
# Paths go through -LiteralPath: with -Path, a [ or ] in a folder name is a wildcard.

function Step { param([string] $Message) Write-Host "`n== $Message" -ForegroundColor Cyan }
function Ok   { param([string] $Message) Write-Host "   $Message" -ForegroundColor Green }
function Note { param([string] $Message) Write-Host "   $Message" -ForegroundColor Yellow }

function Test-Cmd {
  param([string] $Name)
  $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# A native command's exit code is not an error to PowerShell (5.1, or 7 without
# $PSNativeCommandUseErrorActionPreference): check it, or a failed npm ci reads as success.
function Invoke-Checked {
  param([string] $What, [scriptblock] $Command)
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$What failed (exit code $LASTEXITCODE). Fix the error above and re-run this script."
  }
}

function Install-IfMissing {
  param([string] $Command, [string] $WingetId, [string] $Label, [switch] $Optional)
  if (Test-Cmd $Command) { Ok "$Label already installed"; return $true }
  if (-not (Test-Cmd 'winget')) {
    Note "$Label is missing and winget is unavailable - install it manually."
    return $false
  }
  Note "installing $Label ..."
  winget install --id $WingetId --accept-source-agreements --accept-package-agreements -e --silent
  if (Test-Cmd $Command) { Ok "$Label installed"; return $true }
  if ($Optional) {
    Note "$Label did not install; continuing without it (it is optional)."
  } else {
    Note "$Label did not install. Close this terminal, open a new one, and re-run."
  }
  return $false
}

# ---------------------------------------------------------------- prerequisites
Step 'Checking prerequisites'
$hasNode = Install-IfMissing -Command 'node' -WingetId 'OpenJS.NodeJS.LTS' -Label 'Node.js'
if (-not $hasNode) { throw 'Node.js is required. Install it, reopen your terminal, and re-run this script.' }

$nodeVersion = [version]((node --version) -replace '^v', '')
if ($nodeVersion -lt [version]'22.12.0') { throw "Node 22.12 or newer is required (found v$nodeVersion)." }
Ok "Node $(node --version)"

Install-IfMissing -Command 'git' -WingetId 'Git.Git' -Label 'Git' -Optional | Out-Null
Install-IfMissing -Command 'gh'  -WingetId 'GitHub.cli' -Label 'GitHub CLI' -Optional | Out-Null

if (Test-Cmd 'claude') {
  Ok 'Claude Code found - the studying step can use your Claude subscription'
} elseif ($env:ANTHROPIC_API_KEY) {
  Ok 'ANTHROPIC_API_KEY set - the studying step will use the API'
} else {
  Note 'No Claude Code and no ANTHROPIC_API_KEY. Searching and reading code will work;'
  Note 'writing the documents will not until you install Claude Code and sign in.'
}

# ---------------------------------------------------------------------- build
Step 'Building the tool'
Push-Location -LiteralPath $root
try {
  if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) {
    Invoke-Checked 'npm ci' { npm ci }
  } else {
    Invoke-Checked 'npm install' { npm install }
  }
  Invoke-Checked 'npm run build' { npm run build }
  Ok 'Built to dist/'
} finally {
  Pop-Location
}

# ------------------------------------------------- config and Claude Desktop
# The tool's own init writes both: it reads and writes JSON without changing anything it
# did not set, keeps the first backup of the Claude Desktop config, and registers this
# clone's server with --config, so it reads this clone's config wherever it is started.
Step 'Writing configuration and connecting Claude Desktop'
$configPath = Join-Path $root 'expert.config.json'
$cli = Join-Path $root 'dist\cli\index.js'
$initArgs = @($cli, '--config', $configPath, 'init', '--name', 'dev', '--yes')
if ($ReposDir) {
  $initArgs += @('--repos-dir', $ReposDir)
} elseif (-not (Test-Path -LiteralPath $configPath)) {
  # First run with no folder given: the repos/ folder in this clone. On a re-run the
  # existing config already says where the projects are, and init reports it.
  $initArgs += @('--repos-dir', (Join-Path $root 'repos'))
}
if ($GithubUser) { $initArgs += @('--github-user', $GithubUser) }
if ($SkipClaudeDesktop) { $initArgs += '--skip-client' }
Invoke-Checked 'expert init' { node @initArgs }

# ----------------------------------------------------------------- next steps
Step 'Done - what to do next'
Write-Host @"
   1. Put project folders in the projects folder named above
      (or list git URLs in its repos.txt and run: node dist/cli/index.js sync)

   2. See what it found:
      node dist/cli/index.js status

   3. Study ONE project first, so you can check the result cheaply:
      node dist/cli/index.js refresh <project-name>

   4. Then the ones you care about:
      node dist/cli/index.js refresh <name> <name> <name>

   5. Restart Claude Desktop and ask: "What projects do I have?"

   Full walkthrough and troubleshooting: SETUP.md
"@
