<#
.SYNOPSIS
  One-command setup: installs what is missing, builds the tool, and connects it to
  Claude Desktop.

.DESCRIPTION
  Safe to re-run. Nothing is overwritten without a backup, and every step reports what
  it did or why it skipped.

.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -ReposDir 'C:\dev\repos' -GithubUser 'your-username'
#>
[CmdletBinding()]
param(
  # Folder that holds your project folders. Defaults to the repos/ folder in this clone.
  [string] $ReposDir,
  # Optional: only needed to pull repos down from GitHub.
  [string] $GithubUser,
  # Skip editing the Claude Desktop config.
  [switch] $SkipClaudeDesktop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Step { param([string] $Message) Write-Host "`n== $Message" -ForegroundColor Cyan }
function Ok   { param([string] $Message) Write-Host "   $Message" -ForegroundColor Green }
function Note { param([string] $Message) Write-Host "   $Message" -ForegroundColor Yellow }

function Test-Cmd {
  param([string] $Name)
  $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-IfMissing {
  param([string] $Command, [string] $WingetId, [string] $Label, [switch] $Optional)
  if (Test-Cmd $Command) { Ok "$Label already installed"; return $true }
  if (-not (Test-Cmd 'winget')) {
    Note "$Label is missing and winget is unavailable — install it manually."
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

$nodeMajor = ((node --version) -replace '^v', '').Split('.')[0] -as [int]
if ($nodeMajor -lt 20) { throw "Node 20 or newer is required (found v$nodeMajor)." }
Ok "Node $(node --version)"

Install-IfMissing -Command 'git' -WingetId 'Git.Git' -Label 'Git' -Optional | Out-Null
Install-IfMissing -Command 'gh'  -WingetId 'GitHub.cli' -Label 'GitHub CLI' -Optional | Out-Null

if (Test-Cmd 'claude') {
  Ok 'Claude Code found — the studying step can use your Claude subscription'
} elseif ($env:ANTHROPIC_API_KEY) {
  Ok 'ANTHROPIC_API_KEY set — the studying step will use the API'
} else {
  Note 'No Claude Code and no ANTHROPIC_API_KEY. Searching and reading code will work;'
  Note 'writing the documents will not until you install Claude Code and sign in.'
}

# ---------------------------------------------------------------------- build
Step 'Building the tool'
Push-Location $root
try {
  if (Test-Path (Join-Path $root 'package-lock.json')) { npm ci } else { npm install }
  npm run build
  Ok 'Built to dist/'
} finally {
  Pop-Location
}

# --------------------------------------------------------------------- config
Step 'Writing configuration'
$configPath = Join-Path $root 'expert.config.json'
if (-not $ReposDir) { $ReposDir = Join-Path $root 'repos' }
$ReposDir = $ReposDir -replace '\\', '/'

if (Test-Path $configPath) {
  Note "expert.config.json already exists — leaving it alone."
  Note "Edit it by hand if you want to change reposDir."
} else {
  $config = [ordered]@{
    reposDir             = $ReposDir
    knowledgeDir         = './knowledge'
    model                = 'claude-sonnet-5'
    excludeRepos         = @()
    includeArchived      = $false
    curateConcurrency    = 2
    curateTimeoutMinutes = 25
  }
  if ($GithubUser) { $config.Insert(0, 'githubUser', $GithubUser) }
  $config | ConvertTo-Json -Depth 4 | Set-Content -Path $configPath -Encoding utf8
  Ok "Wrote expert.config.json (reposDir = $ReposDir)"
  if (-not $GithubUser) {
    Note 'No GitHub username set — that is fine. Copy or clone project folders into'
    Note "$ReposDir and they are analyzable immediately."
  }
}

# ------------------------------------------------------------- claude desktop
if (-not $SkipClaudeDesktop) {
  Step 'Connecting to Claude Desktop'
  $desktopConfig = Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
  $entryPoint = (Join-Path $root 'dist/cli/index.js') -replace '\\', '/'

  # Built without ConvertFrom-Json -AsHashtable so this also runs on the Windows
  # PowerShell 5.1 that ships with Windows, not just PowerShell 7.
  $existing = $null
  $readable = $true
  if (Test-Path $desktopConfig) {
    $backup = "$desktopConfig.backup"
    Copy-Item $desktopConfig $backup -Force
    Ok "Backed up existing config to $backup"
    try {
      $existing = Get-Content $desktopConfig -Raw | ConvertFrom-Json
    } catch {
      $readable = $false
      Note 'Existing config is not valid JSON — not touching it. Add this entry yourself:'
      Note "  `"repos-expert`": { `"command`": `"node`", `"args`": [`"$entryPoint`", `"mcp`"] }"
    }
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $desktopConfig) | Out-Null
  }

  if ($readable) {
    $servers = [ordered]@{}
    $out = [ordered]@{}
    if ($existing) {
      foreach ($prop in $existing.PSObject.Properties) {
        if ($prop.Name -eq 'mcpServers') {
          foreach ($server in $prop.Value.PSObject.Properties) { $servers[$server.Name] = $server.Value }
        } else {
          $out[$prop.Name] = $prop.Value
        }
      }
    }
    $servers['repos-expert'] = [ordered]@{
      command = 'node'
      args    = @($entryPoint, 'mcp')
    }
    $out['mcpServers'] = $servers
    $out | ConvertTo-Json -Depth 8 | Set-Content -Path $desktopConfig -Encoding utf8
    Ok 'Added repos-expert to Claude Desktop (other servers left untouched)'
    Note 'Quit Claude Desktop from the system tray and reopen it to pick this up.'
  }
}

# ----------------------------------------------------------------- next steps
Step 'Done — what to do next'
Write-Host @"
   1. Put project folders in:  $ReposDir
      (or run: node dist/cli/index.js sync   — needs githubUser + gh login)

   2. See what it found:
      node dist/cli/index.js status

   3. Study ONE project first, so you can check the result cheaply:
      node dist/cli/index.js refresh <project-name>

   4. Then the ones you care about:
      node dist/cli/index.js refresh <name> <name> <name>

   5. Restart Claude Desktop and ask: "What projects do I have?"

   Full walkthrough and troubleshooting: SETUP.md
"@
