#!/usr/bin/env bash
# R7: read-only post-release qualification. No LinkedIn action, email, or DB write.
# Usage: scripts/linkedin-production-readonly-qualify.sh <40-char-release-sha>
# Optional: EXPECT_HELD_ACTIONS, EXPECT_UNKNOWN_OUTCOMES, EXPECT_RUNNING_CAMPAIGNS, EXPECT_PAUSED_CAMPAIGNS, EXPECT_SENT_LAST_30M
set -euo pipefail
die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }
[[ $# -eq 1 && "$1" =~ ^[0-9a-fA-F]{40}$ ]] || die 'Expected full release SHA'
SHA="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGIN="${TREVRA_APP_ORIGIN:-https://app.usetrevra.com}"
[[ "$ORIGIN" =~ ^https://[a-zA-Z0-9.-]+$ ]] || die 'HTTPS origin required'
for cmd in jq curl ssh; do command -v "$cmd" >/dev/null || die "Missing $cmd"; done
STATE="$ROOT/infra/oracle/terraform-micro/terraform.tfstate"
# Terraform state is intentionally ignored/untracked, so a feature worktree
# usually does not contain it. Resolve through Git's original common dir.
if [[ ! -f "$STATE" ]]; then
  COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
  STATE="$(dirname "$COMMON_DIR")/infra/oracle/terraform-micro/terraform.tfstate"
fi
if [[ -n "${TREVRA_ORACLE_HOST:-}" ]]; then HOST="$TREVRA_ORACLE_HOST"; else
  [[ -f "$STATE" ]] || die 'Oracle host missing: set TREVRA_ORACLE_HOST'
  HOST="$(jq -er '.outputs.app_public_ip.value' "$STATE")"
fi
[[ "$HOST" =~ ^[a-zA-Z0-9.:-]+$ ]] || die 'Invalid Oracle hostname'
KEY="${TREVRA_ORACLE_SSH_KEY:-$HOME/.ssh/trevra_oracle}"
[[ -f "$KEY" ]] || die 'Missing SSH key'
ssh_args=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
remote=(ssh "${ssh_args[@]}" "ubuntu@$HOST")
TARGET="ghcr.io/olaryn-lab/trevra:sha-$SHA"
IMAGES="$("${remote[@]}" "docker inspect --format '{{.Config.Image}}' trevra-worker-1 trevra-trevra-1")"
[[ "$(printf '%s\n' "$IMAGES" | grep -Fxc "$TARGET")" -eq 2 ]] || die 'API and worker immutable image mismatch'
pass "API/worker image $SHA"
"${remote[@]}" 'docker exec -i trevra-worker-1 node -' <<'JS'
(async()=>{
 const r=await fetch('http://127.0.0.1:8081/health'); const h=await r.json();
 if(!r.ok||h.linkedin?.scheduler?.healthy!==true||h.linkedin?.stallMonitor?.lastError)throw Error('scheduler or monitor unhealthy');
 for(const name of ['planning','outbound','maintenance']){const x=h.linkedin?.cycles?.[name];
  if(x?.lastError||!Number.isFinite(Date.parse(x?.lastCompletedAt??''))||Date.now()-Date.parse(x.lastCompletedAt)>20*60_000)throw Error('cycle stale: '+name);}
 if(!h.linkedin?.stallMonitor?.checkedAt)throw Error('stall monitor never checked');
 console.log('PASS scheduler, execution cycles, stall monitor');
})().catch(e=>{console.error('FAIL worker:',e.message);process.exitCode=1});
JS
# GitHub's hosted runner egress can be challenged by Cloudflare Bot Fight
# Mode. Probe the real public domain from the Oracle server instead; this
# still traverses public DNS, TLS and the Cloudflare edge.
API_HEALTH="$("${remote[@]}" "curl --silent --show-error --fail --max-time 20 '$ORIGIN/api/health'")" ||
  die 'Public API health request failed'
printf '%s\n' "$API_HEALTH" | jq -e '.ok == true and .service == "trevra-api" and .database == "postgresql"' >/dev/null || die 'API health failed'
pass 'public API health'
CALLBACK="$("${remote[@]}" "curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code} %{redirect_url}' '$ORIGIN/api/auth/oauth2/callback/authward?error=access_denied'")"
[[ "$CALLBACK" == "302 $ORIGIN/login?error=access_denied" ]] || die 'Authward error callback incorrect'
pass 'Authward error callback'
# Verify TLS and authentication only; intentionally never call sendMail().
"${remote[@]}" 'docker exec -i trevra-worker-1 node --input-type=module -' <<'JS'
import nodemailer from 'nodemailer';
const e=process.env;const keys=['SMTP_SERVER','SMTP_PORT','SMTP_USERNAME','SMTP_PASSWORD','EMAIL_FROM'];
try{if(keys.some(k=>!e[k]))throw Error('incomplete config');const port=Number(e.SMTP_PORT);
 const t=nodemailer.createTransport({host:e.SMTP_SERVER,port,secure:port===465,requireTLS:port!==465,auth:{user:e.SMTP_USERNAME,pass:e.SMTP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:15000});
 try{await t.verify()}finally{t.close()}console.log('PASS SMTP TLS/auth (no email sent)');
}catch(err){console.error('FAIL SMTP:',String(err.code||err.message).slice(0,100));process.exitCode=1}
JS
COUNTS="$("${remote[@]}" 'docker exec -i trevra-db-postgres-1 psql -U trevra -d trevra -Atq' <<'SQL'
SELECT 'HELD_ACTIONS='||count(*) FROM linkedin_actions WHERE status='held';
SELECT 'UNKNOWN_OUTCOMES='||count(*) FROM linkedin_actions WHERE status='planned' AND settlement_hold_at IS NOT NULL;
SELECT 'RUNNING_CAMPAIGNS='||count(*) FROM linkedin_campaigns WHERE status='running';
SELECT 'PAUSED_CAMPAIGNS='||count(*) FROM linkedin_campaigns WHERE status='paused';
SELECT 'SENT_LAST_30M='||count(*) FROM linkedin_actions WHERE status='sent' AND recorded_at>now()-interval '30 minutes';
SELECT 'ONLINE_COMPANIONS='||count(*) FROM linkedin_companion_devices WHERE revoked_at IS NULL AND last_seen_at>now()-interval '90 seconds';
SELECT 'STALL_NOTIFICATIONS='||count(*) FROM linkedin_campaign_stall_notifications;
SQL
)"
while IFS='=' read -r key value; do
 [[ "$key" =~ ^[A-Z0-9_]+$ && "$value" =~ ^[0-9]+$ ]] || die 'Malformed ledger response'
 [[ "$key" != 'ONLINE_COMPANIONS' || "$value" -gt 0 ]] || die 'Companion offline'
 expected="EXPECT_$key"
 if [[ -n "${!expected:-}" && "$value" != "${!expected}" ]]; then die "$key changed from baseline"; fi
 pass "$key=$value"
done <<< "$COUNTS"
pass 'R7 read-only qualification complete; no send or mutation'
