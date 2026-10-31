# Billing enforcement rollout (TRV-057)

Trevra reads plans, credits and capabilities from Olaryn Billing. Blocking a
workspace and charging it are owner decisions, so neither happens just because
Billing is configured (`infra/gcp/deploy.sh` configures it by default). One
setting decides:

```
TREVRA_BILLING_ENFORCEMENT=off | observe | enforce
```

Unset or any unrecognized value means `observe` (an unrecognized value logs one
warning). Set the same value on the web server and the worker: the server owns
the limit checks, the worker owns usage charging. The GCP deploy material does
not set it, so production runs `observe` until someone adds it to the Cloud Run
environment.

When Billing is not configured (`BILLING_BASE_URL` etc. unset), everything is
permissive in every mode and nothing is recorded or charged.

## Modes

|           | Limit checks                                                                   | Records                                 | Usage charged |
| --------- | ------------------------------------------------------------------------------ | --------------------------------------- | ------------- |
| `off`     | skipped; write paths never ask Billing                                         | nothing                                 | no            |
| `observe` | computed, never block                                                          | `billing.entitlement.would_deny` events | no            |
| `enforce` | block with HTTP 402 (`code: entitlement_denied`, `billingUrl: /setup/billing`) | nothing extra                           | yes           |

The checked write paths are: campaign start or resume (running-campaign cap
and credits), LinkedIn seat create, seat daily-limit raises, seat credentials
and detection for a new seat key, and team invitations and joins. That covers
Trevra's POST /api/team/members and Better Auth's own organization endpoints.
Pausing, editing, lowering limits and reads are never checked.

## Observe: would-deny events

Each denial that would have blocked is appended to the workspace's domain
event ledger as `billing.entitlement.would_deny` (stream type
`billing_entitlement`). The payload is `{entitlement, reason, limit, used,
requested}`: counts only, no content. It is written at most once per workspace,
entitlement and UTC hour (stream id `<entitlement>:<YYYY-MM-DDTHH>`). To size the
impact before switching to `enforce`:

```sql
SELECT workspace_id, payload_json->>'entitlement' AS entitlement,
       payload_json->>'reason' AS reason, count(*) AS hours
FROM domain_events
WHERE event_type = 'billing.entitlement.would_deny'
  AND occurred_at > now() - interval '7 days'
GROUP BY 1, 2, 3 ORDER BY hours DESC;
```

Billing has no free plan. Once Billing is configured, a workspace without a
subscription has no capabilities, so under `enforce` it could not start
campaigns, add seats or invite teammates. Observe first, and resolve those
workspaces before you switch.

The billing screen (`/setup/billing`) shows the mode. Outside `enforce` it shows
what would be blocked as a non-blocking notice.

## Usage charging

Only under `enforce`, and only in the worker's billing pass (every 5 minutes).
The first enforce pass stamps `billing_workspace_state.metering_started_at` for
every workspace with a cached Billing snapshot. Only actions executed after that
stamp are reserved and settled in credits. Any `observe` or `off` pass clears the
stamps. Switching to `enforce`, or back to it later, therefore never charges for
work done before the switch.

Rows already queued under `enforce` and not yet reported when you leave it stay
pending in `billing_usage_outbox`. They are reported after the next switch back
to `enforce`, because that work was done while enforcing.

The informational 30-day annual renewal e-mail, snapshot refresh and pruning run
in every mode.

## Known gaps

- Two direct Better Auth invitation requests racing at the team limit are not
  serialized. Better Auth 1.7 runs `beforeCreateInvitation` and the insert
  outside any transaction the hook can join. Trevra's own POST /api/team/members
  holds the entitlement lock across the insert.
- The check for a new seat key's credentials or detection is a pre-check, and
  the worker's later seat write is not gated.

## Switching

1. Run `observe` and review the would-deny query above.
2. Set `TREVRA_BILLING_ENFORCEMENT=enforce` on both the web server and the
   worker, then redeploy.
3. To back out, set `observe` (or `off`) and redeploy. Blocking stops at once and
   charging stops at the next worker pass.
