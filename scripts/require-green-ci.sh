#!/usr/bin/env bash
# Fail closed unless the exact release commit has successful main-branch App quality.
# A passing image build is not proof that the PostgreSQL acceptance suite passed.
set -euo pipefail
fail() { printf 'FAIL release CI gate: %s\n' "$*" >&2; exit 1; }
[[ ${1:-} =~ ^[0-9a-fA-F]{40}$ ]] || fail 'full 40-character release SHA required'
SHA="$1"
REPO="${GITHUB_REPOSITORY:-}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'GITHUB_REPOSITORY must be owner/repo'
ATTEMPTS="${TREVRA_CI_WAIT_ATTEMPTS:-60}"
INTERVAL="${TREVRA_CI_POLL_SECONDS:-15}"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ && "$INTERVAL" =~ ^[0-9]+$ ]] ||
  fail 'invalid polling configuration'
for cmd in gh jq; do command -v "$cmd" >/dev/null || fail "missing $cmd"; done

for (( attempt=1; attempt<=ATTEMPTS; attempt++ )); do
  # Require CI's push event on main, not a green PR check or an older SHA.
  response="$(gh api -H 'Accept: application/vnd.github+json' \
    "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&per_page=30")" ||
    fail 'unable to read GitHub CI status'
  result="$(jq -er --arg sha "$SHA" '
    [.workflow_runs[]? | select(.head_sha == $sha and .head_branch == "main" and .event == "push")]
    | sort_by(.run_number, .run_attempt) | last
    | if . == null then "" else [.status, (.conclusion // "")] | @tsv end
  ' <<< "$response")" || fail 'invalid GitHub CI response'
  if [[ -n "$result" ]]; then
    IFS=$'\t' read -r status conclusion <<< "$result"
    if [[ "$status" == "completed" ]]; then
      [[ "$conclusion" == "success" ]] ||
        fail "App quality for $SHA completed with ${conclusion:-unknown}"
      printf 'PASS App quality succeeded on main for %s\n' "$SHA"
      exit 0
    fi
    printf 'WAIT App quality for %s is %s (%s/%s)\n' "$SHA" "$status" "$attempt" "$ATTEMPTS"
  else
    printf 'WAIT App quality for %s not yet found (%s/%s)\n' "$SHA" "$attempt" "$ATTEMPTS"
  fi
  if ((attempt < ATTEMPTS)); then sleep "$INTERVAL"; fi
done
fail "App quality did not complete successfully for $SHA within bounded wait"
