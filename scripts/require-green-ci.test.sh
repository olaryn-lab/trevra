#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MOCK_DIR="$(mktemp -d)"
trap 'rm -rf "$MOCK_DIR"' EXIT
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$FAKE_CI_JSON"\n' > "$MOCK_DIR/gh"
chmod +x "$MOCK_DIR/gh"
run() {
  PATH="$MOCK_DIR:$PATH" GITHUB_REPOSITORY='olaryn-lab/trevra' \
    TREVRA_CI_WAIT_ATTEMPTS=1 TREVRA_CI_POLL_SECONDS=0 \
    FAKE_CI_JSON="$1" bash "$ROOT/scripts/require-green-ci.sh" "$FAKE_SHA"
}
fixture() {
  printf '{"workflow_runs":[{"head_sha":"%s","head_branch":"%s","event":"%s","status":"%s","conclusion":%s,"run_number":3,"run_attempt":1}]}' \
    "$1" "$2" "$3" "$4" "$5"
}
run "$(fixture "$FAKE_SHA" main push completed '"success"')" >/dev/null
for response in \
  "$(fixture "$FAKE_SHA" main push completed '"failure"')" \
  "$(fixture "$FAKE_SHA" main push in_progress null)" \
  "$(fixture "$FAKE_SHA" feature push completed '"success"')" \
  "$(fixture bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb main push completed '"success"')" \
  '{"workflow_runs":[]}'; do
  if run "$response" >/dev/null 2>&1; then
    echo 'FAIL: unsafe CI evidence was accepted' >&2
    exit 1
  fi
done
echo 'PASS release CI gate: exact main success accepted; failure, pending, wrong branch/SHA, missing rejected'
