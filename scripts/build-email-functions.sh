#!/usr/bin/env bash
# Builds self-contained copies of the e-mail Edge Functions, ready to deploy.
#   scripts/build-email-functions.sh test <out-dir>   no-send transport (cannot send e-mail)
#   scripts/build-email-functions.sh live <out-dir>   real transport (production, after review)
# Each function folder gets its own copies of the shared files, with imports rewritten
# from ../_shared/ to ./ . The test build is checked: if any file can reach the e-mail
# provider or read an e-mail secret, the build fails.
set -euo pipefail
target="${1:-}"; out="${2:-}"
[[ "$target" == test || "$target" == live ]] && [[ -n "$out" ]] || { echo "usage: $0 test|live <out-dir>" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)/supabase/functions"
transport="$root/_shared/email-transport.ts"
[[ "$target" == test ]] && transport="$root/_shared/email-transport.dryrun.ts"

declare -A shared=( [resend-email]="request.ts sanitize-email-html.ts" [sub-invoice-submit]="request.ts" )

# Output folder safety. The folder is emptied before each build, so only what this script made
# itself is ever deleted (checked by scripts/test-build-email-functions.sh):
#   * the parent folder must already exist; the last part cannot be empty, "." or "..";
#   * the folder cannot be a symlink, "/", $HOME, the repository or any folder that contains them,
#     nor be inside the repository's supabase/ or .git/ folders;
#   * an existing non-empty folder is reused only if it holds nothing but this script's marker
#     file (exact content, not a symlink) and real function folders with the expected names.
#     Anything else is refused and left untouched.
#   * Only those known entries are removed; nothing else is ever deleted recursively.
fail() { echo "FAIL: $*" >&2; exit 2; }
marker=".email-functions-build"
marker_text="made by scripts/build-email-functions.sh; safe to delete"
while [[ "$out" == */ ]]; do out="${out%/}"; done
[[ -n "$out" ]] || fail "output folder cannot be /"
name="$(basename -- "$out")"; parent="$(dirname -- "$out")"
[[ "$name" != "." && "$name" != ".." ]] || fail "output folder cannot end in . or .."
[[ -d "$parent" ]] || fail "parent folder does not exist: $parent"
parent="$(cd -- "$parent" && pwd -P)"; out="${parent%/}/$name"
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
for keep in / "$repo" "${HOME:+$(cd -- "$HOME" 2>/dev/null && pwd -P)}"; do
  [[ -n "$keep" ]] || continue
  [[ "$out" != "$keep" && "${keep%/}/" != "$out/"* ]] || fail "refusing to use $out (it is or contains $keep)"
done
for inside in "$repo/supabase" "$repo/.git"; do
  [[ "$out/" != "$inside/"* ]] || fail "refusing to build inside $inside"
done
if [[ -L "$out" ]]; then fail "output folder is a symlink: $out"; fi
if [[ -e "$out" ]]; then
  [[ -d "$out" ]] || fail "output path exists and is not a folder: $out"
  shopt -s dotglob nullglob; entries=("$out"/*); shopt -u dotglob nullglob
  if [[ ${#entries[@]} -gt 0 ]]; then
    [[ -f "$out/$marker" && ! -L "$out/$marker" && "$(cat -- "$out/$marker")" == "$marker_text" ]] \
      || fail "$out is not empty and was not made by this script (no valid $marker); choose a new or empty folder"
    for e in "${entries[@]}"; do
      b="$(basename -- "$e")"
      [[ "$b" == "$marker" ]] && continue
      [[ -n "${shared[$b]+x}" && -d "$e" && ! -L "$e" ]] \
        || fail "$out contains '$b', which this script does not make; nothing was deleted"
    done
    for e in "${entries[@]}"; do rm -rf -- "$e"; done
  fi
else
  mkdir -- "$out"
fi
printf '%s\n' "$marker_text" > "$out/$marker"
built=()
for fn in "${!shared[@]}"; do
  [[ -d "$root/$fn" ]] || continue   # a function that is not in this branch yet is skipped
  built+=("$fn")
  mkdir -p "$out/$fn"
  sed 's#"\.\./_shared/#"./#g' "$root/$fn/index.ts" > "$out/$fn/index.ts"
  for f in ${shared[$fn]}; do cp "$root/_shared/$f" "$out/$fn/$f"; done
  cp "$transport" "$out/$fn/email-transport.ts"
  # Per-function import map (npm packages pinned to an exact version), when the function has one.
  [[ -f "$root/$fn/deno.json" ]] && cp "$root/$fn/deno.json" "$out/$fn/deno.json"
  # Every bare import must be declared in that function's deno.json.
  for spec in $(grep -hoE '^import [^"]*"[^".][^"]*"' "$out/$fn"/*.ts | sed -E 's/.*"([^"]+)"$/\1/' | sort -u); do
    grep -q "\"$spec\":" "$out/$fn/deno.json" 2>/dev/null || { echo "FAIL $fn: import \"$spec\" not pinned in deno.json" >&2; exit 1; }
  done
  if grep -qE '^import .*\.\./_shared/' "$out/$fn/index.ts"; then echo "FAIL $fn: unresolved shared import" >&2; exit 1; fi
done

if [[ "$target" == test ]]; then
  if grep -rnE 'resend\.com|Deno\.env\.get\("(RESEND_API_KEY|EMAIL_FROM|EMAIL_REPLY_TO|EMAIL_MODE)"\)' "$out"; then
    echo "FAIL: test build can reach the e-mail provider or read an e-mail secret" >&2; exit 1
  fi
  for fn in "${built[@]}"; do
    grep -q 'TRANSPORT = "test_no_send"' "$out/$fn/email-transport.ts" || { echo "FAIL $fn: not the no-send transport" >&2; exit 1; }
  done
  [[ ${#built[@]} -gt 0 ]] || { echo "FAIL: no function found to build" >&2; exit 1; }
  echo "OK test build (no-send) in $out: ${built[*]}"
else
  echo "OK live build in $out: ${built[*]} — deploy only after review"
fi
