#!/usr/bin/env bash
# Tests the output-folder safety of scripts/build-email-functions.sh.
#   scripts/test-build-email-functions.sh
# Needs only bash and coreutils; no network, no Supabase, nothing is deployed.
#
# The test cannot delete anything outside its own temporary folder, even if the build script were
# broken:
#   * it runs a COPY of the build script inside a temporary fake repository, with a fake $HOME;
#   * every case that must be refused runs with a guard "rm" first in PATH, which only records
#     the call and fails. A refused case must also leave rm uncalled and the sentinel files intact.
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd -P)"
T="$(mktemp -d)"; T="$(cd -- "$T" && pwd -P)"
trap 'rm -rf -- "$T"' EXIT

repo="$T/repo"; home="$T/home"; work="$T/work"; guard="$T/guard"
mkdir -p "$repo/scripts" "$repo/supabase" "$repo/.git" "$home" "$work" "$guard"
cp -- "$src/scripts/build-email-functions.sh" "$repo/scripts/"
cp -R -- "$src/supabase/functions" "$repo/supabase/functions"
build="$repo/scripts/build-email-functions.sh"
echo "home sentinel" > "$home/sentinel.txt"
echo "repo sentinel" > "$repo/sentinel.txt"
cat > "$guard/rm" <<EOF
#!/usr/bin/env bash
echo "rm \$*" >> "$T/rm.log"
exit 99
EOF
chmod +x "$guard/rm"
marker=".email-functions-build"
marker_text="made by scripts/build-email-functions.sh; safe to delete"

pass=0; failed=0
ok_line() { pass=$((pass + 1)); printf 'ok    %s\n' "$1"; }
bad_line() { failed=$((failed + 1)); printf 'FAIL  %s: %s\n' "$1" "$2"; }

sentinels_intact() {
  [[ "$(cat "$home/sentinel.txt" 2>/dev/null)" == "home sentinel" && "$(cat "$repo/sentinel.txt" 2>/dev/null)" == "repo sentinel" ]]
}

# refuse <description> <out-dir...>: must exit 2, never call rm, keep every sentinel.
refuse() {
  local desc="$1"; shift
  : > "$T/rm.log"
  local code=0
  ( cd "$work" && HOME="$home" PATH="$guard:$PATH" bash "$build" test "$@" ) > "$T/out.txt" 2>&1 || code=$?
  if [[ $code -ne 2 ]]; then bad_line "$desc" "exit $code (expected 2): $(tail -1 "$T/out.txt")"
  elif [[ -s "$T/rm.log" ]]; then bad_line "$desc" "rm was called: $(cat "$T/rm.log")"
  elif ! sentinels_intact; then bad_line "$desc" "a sentinel file changed"
  else ok_line "$desc (refused: $(tail -1 "$T/out.txt" | cut -c1-70))"; fi
}

# build_ok <description> <out-dir>: must succeed and leave a marked, built folder.
build_ok() {
  local desc="$1" dir="$2" check="${3:-$2}"
  local code=0
  ( cd "$work" && HOME="$home" bash "$build" test "$dir" ) > "$T/out.txt" 2>&1 || code=$?
  if [[ $code -ne 0 ]]; then bad_line "$desc" "exit $code: $(tail -1 "$T/out.txt")"
  elif [[ "$(cat "$check/$marker" 2>/dev/null)" != "$marker_text" ]]; then bad_line "$desc" "marker missing or wrong"
  elif [[ ! -f "$check/sub-invoice-submit/index.ts" ]]; then bad_line "$desc" "function not built"
  elif ! sentinels_intact; then bad_line "$desc" "a sentinel file changed"
  else ok_line "$desc"; fi
}

# --- cases that must be refused -------------------------------------------------------------
refuse "no output argument"
refuse "/" "/"
refuse "//" "//"
refuse "\$HOME" "$home"
refuse "\$HOME with trailing slash" "$home/"
refuse "repository root" "$repo"
refuse "folder containing the repository" "$T"
refuse "inside repository supabase/" "$repo/supabase/out"
refuse "inside repository supabase/functions" "$repo/supabase/functions"
refuse "inside repository .git/" "$repo/.git/out"
refuse "path ending in ." "$work/."
refuse "path ending in .." "$work/x/.."
refuse "parent folder missing" "$work/missing/out"

mkdir "$work/precious"; echo keep > "$work/precious/important.txt"
refuse "non-empty folder without marker" "$work/precious"
[[ "$(cat "$work/precious/important.txt")" == keep ]] && ok_line "  ...its file is untouched" || bad_line "precious file" "changed"

ln -s "$work/precious" "$work/link"
refuse "symlink to a folder" "$work/link"
refuse "existing file instead of folder" "$work/precious/important.txt"

mkdir "$work/wrongmarker"; echo "something else" > "$work/wrongmarker/$marker"; echo x > "$work/wrongmarker/data.txt"
refuse "marker with wrong content" "$work/wrongmarker"
[[ -f "$work/wrongmarker/data.txt" ]] && ok_line "  ...its file is untouched" || bad_line "wrongmarker data" "deleted"

mkdir "$work/linkmarker"; printf '%s\n' "$marker_text" > "$work/real-marker"; ln -s "$work/real-marker" "$work/linkmarker/$marker"
refuse "marker that is a symlink" "$work/linkmarker"

mkdir "$work/extra"; printf '%s\n' "$marker_text" > "$work/extra/$marker"; echo notes > "$work/extra/notes.txt"
refuse "marked folder with an unexpected file" "$work/extra"
[[ -f "$work/extra/notes.txt" ]] && ok_line "  ...the unexpected file is untouched" || bad_line "extra notes" "deleted"

mkdir "$work/fnlink"; printf '%s\n' "$marker_text" > "$work/fnlink/$marker"; ln -s "$work/precious" "$work/fnlink/sub-invoice-submit"
refuse "marked folder whose function folder is a symlink" "$work/fnlink"
[[ -f "$work/precious/important.txt" ]] && ok_line "  ...the symlink target is untouched" || bad_line "fnlink target" "deleted"

# --- cases that must work --------------------------------------------------------------------
build_ok "new folder" "$work/out"
echo stale > "$work/out/sub-invoice-submit/stale.txt"
build_ok "rebuild into the same folder" "$work/out"
[[ ! -e "$work/out/sub-invoice-submit/stale.txt" ]] && ok_line "  ...old build output was replaced" || bad_line "rebuild" "stale file kept"
mkdir "$work/empty"
build_ok "existing empty folder" "$work/empty"
build_ok "trailing slashes" "$work/out//" "$work/out"
build_ok "relative path" "rel-out" "$work/rel-out"

echo
echo "passed: $pass  failed: $failed"
[[ $failed -eq 0 ]]
