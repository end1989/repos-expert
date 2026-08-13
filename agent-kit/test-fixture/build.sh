#!/usr/bin/env bash
# Builds the test fixture into a scratch directory: two git repos plus the kit.
#
# The repos are committed here without .git directories - this script creates them, so a
# run always starts from a known commit and meta.json stamping can be checked.
#
#   ./build.sh /tmp/kit-test
#   cd /tmp/kit-test && claude
#
# Then work through EXPECTED.md.
set -euo pipefail

TARGET="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/.." && pwd)"

if [ -z "$TARGET" ]; then
  echo "usage: $0 <target-dir>" >&2
  exit 1
fi
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "refusing to build into a non-empty directory: $TARGET" >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -r "$HERE/repos/." "$TARGET/"

for repo in "$TARGET"/*/; do
  name="$(basename "$repo")"
  (
    cd "$repo"
    git init -q -b main .
    git add -A
    git -c user.email=fixture@example.invalid -c user.name=fixture commit -qm "initial"
  )
  echo "  repo: $name @ $(git -C "$repo" rev-parse --short HEAD)"
done

cp "$KIT/CLAUDE.md" "$TARGET/CLAUDE.md"
cp -r "$KIT/.claude" "$TARGET/.claude"
echo "  kit:  CLAUDE.md + .claude/"

cat <<EOF

Fixture built at $TARGET

  cd "$TARGET"
  claude

Then:
  /study orders-api        the main test - see EXPECTED.md sections 1-4
  /study order-worker
  /map                     sections 5 and 6

Grade against EXPECTED.md. Section 1 is the one that matters: three routes, not five.
EOF
