#!/usr/bin/env bash
# Installs the repo-expert agent kit into a folder of code repositories.
#
# Nothing is overwritten: an existing CLAUDE.md is left alone and reported, because a
# code folder may already have one that matters more than this.
#
#   ./install.sh ~/code
#   ./install.sh ~/code --force
set -euo pipefail

INTO="${1:-}"
FORCE="${2:-}"
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$KIT/template"
KIT_VERSION="$(cat "$KIT/VERSION" 2>/dev/null || echo unknown)"

if [ -z "$INTO" ]; then
  echo "usage: $0 <folder-of-repos> [--force]" >&2
  exit 1
fi
[ -d "$TEMPLATE" ] || { echo "Kit is incomplete: $TEMPLATE missing. Copy the whole agent-kit folder." >&2; exit 1; }
[ -d "$INTO" ] || { echo "No such folder: $INTO" >&2; exit 1; }

count=0
for d in "$INTO"/*/; do [ -d "$d/.git" ] && count=$((count+1)); done

echo
echo "repo-expert agent kit $KIT_VERSION"
echo "Installing into $INTO"
echo "  found $count git repositories there"
[ "$count" -eq 0 ] && echo "  (none yet - the kit still installs; add repos before /study)"

if [ -f "$INTO/CLAUDE.md" ] && [ "$FORCE" != "--force" ]; then
  cp "$TEMPLATE/CLAUDE.md" "$INTO/CLAUDE.repo-expert.md"
  echo "  ! CLAUDE.md already exists - left it alone."
  echo "    Wrote CLAUDE.repo-expert.md instead. Merge what you want, or delete it."
else
  cp "$TEMPLATE/CLAUDE.md" "$INTO/CLAUDE.md"
  echo "  + CLAUDE.md"
fi

for sub in agents commands; do
  mkdir -p "$INTO/.claude/$sub"
  for f in "$TEMPLATE/dot-claude/$sub"/*; do
    name="$(basename "$f")"
    if [ -f "$INTO/.claude/$sub/$name" ] && [ "$FORCE" != "--force" ]; then
      echo "  = .claude/$sub/$name (already there, kept)"
    else
      cp "$f" "$INTO/.claude/$sub/$name"
      echo "  + .claude/$sub/$name"
    fi
  done
done

mkdir -p "$INTO/_knowledge"
echo "  + _knowledge/  (empty until you study something)"

# Stamped so "which version do you have?" has an answer months from now.
echo "$KIT_VERSION" > "$INTO/.claude/kit-version.txt"
echo "  + .claude/kit-version.txt  ($KIT_VERSION)"

cat <<EOF

Done. Nothing is running - the kit is just files.

Next:
  1. cd "$INTO"
  2. claude                      # start Claude Code in that folder
  3. /study <one-repo-name>      # study ONE first, read the result
  4. /study <name> <name> ...    # then the rest, in batches
  5. /map                        # build the portfolio + cross-repo view

Each repo takes a few minutes of model time. Check the first one before doing forty.
EOF
