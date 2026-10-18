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
rm -rf "$out"; mkdir -p "$out"
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
