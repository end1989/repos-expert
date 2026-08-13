<#
.SYNOPSIS
  Installs the repo-expert agent kit into a folder of code repositories.

.DESCRIPTION
  Copies CLAUDE.md and the .claude/ agent + commands into the target folder. Nothing is
  overwritten: an existing CLAUDE.md is left alone and reported, because a code folder may
  already have one that matters more than this.

  No npm, no server, no background process. After this, open a terminal in the folder and
  run `claude`.

  ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the file has a
  BOM, so a stray em-dash becomes a parse error on someone else's machine.

.EXAMPLE
  .\install.ps1 -Into "C:\dev\repos"
  .\install.ps1 -Into "C:\dev\repos" -Force     # replace files this kit owns
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Into,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot 'template'

$versionFile = Join-Path $PSScriptRoot 'VERSION'
$kitVersion = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { 'unknown' }

if (-not (Test-Path $template)) {
  throw "Kit is incomplete: $template is missing. Copy the whole agent-kit folder, not just this script."
}
if (-not (Test-Path $Into)) {
  throw "No such folder: $Into. Create it and put your project folders in it first."
}

$repos = @(Get-ChildItem -Path $Into -Directory -ErrorAction SilentlyContinue |
           Where-Object { Test-Path (Join-Path $_.FullName '.git') })

Write-Host ""
Write-Host "repo-expert agent kit $kitVersion" -ForegroundColor Cyan
Write-Host "Installing into $Into"
Write-Host "  found $($repos.Count) git repositories there"
if ($repos.Count -eq 0) {
  Write-Host "  (none yet - that is fine, the kit still installs; add repos before /study)" -ForegroundColor Yellow
}

# CLAUDE.md is the one file a code folder may already own. Never clobber it silently.
$claudeMd = Join-Path $Into 'CLAUDE.md'
if ((Test-Path $claudeMd) -and -not $Force) {
  $keep = Join-Path $Into 'CLAUDE.repo-expert.md'
  Copy-Item (Join-Path $template 'CLAUDE.md') $keep -Force
  Write-Host "  ! CLAUDE.md already exists, left it alone." -ForegroundColor Yellow
  Write-Host "    Wrote $keep instead. Merge what you want, or delete it."
} else {
  Copy-Item (Join-Path $template 'CLAUDE.md') $claudeMd -Force
  Write-Host "  + CLAUDE.md"
}

# The template ships .claude as "dot-claude" so the kit's own commands never get picked up
# by a Claude session opened inside the kit folder itself.
$dest = Join-Path $Into '.claude'
foreach ($sub in @('agents', 'commands')) {
  $srcDir = Join-Path $template "dot-claude\$sub"
  $dstDir = Join-Path $dest $sub
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  foreach ($file in Get-ChildItem $srcDir -File) {
    $target = Join-Path $dstDir $file.Name
    if ((Test-Path $target) -and -not $Force) {
      Write-Host "  = .claude\$sub\$($file.Name) (already there, kept)" -ForegroundColor DarkGray
    } else {
      Copy-Item $file.FullName $target -Force
      Write-Host "  + .claude\$sub\$($file.Name)"
    }
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $Into '_knowledge') | Out-Null
Write-Host "  + _knowledge\  (empty until you study something)"

# Stamped so "which version do you have?" has an answer months from now.
Set-Content -Path (Join-Path $dest 'kit-version.txt') -Value $kitVersion -Encoding ascii
Write-Host "  + .claude\kit-version.txt  ($kitVersion)"

Write-Host ""
Write-Host "Done. Nothing is running - the kit is just files." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. cd `"$Into`""
Write-Host "  2. claude                      # start Claude Code in that folder"
Write-Host "  3. /study <one-repo-name>      # study ONE first, read the result"
Write-Host "  4. /study <name> <name> ...    # then the rest, in batches"
Write-Host "  5. /map                        # build the portfolio + cross-repo view"
Write-Host ""
Write-Host "Each repo takes a few minutes of model time. Check the first one before"
Write-Host "doing forty."
