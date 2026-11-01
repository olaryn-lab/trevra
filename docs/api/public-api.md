# Trevra public API (v1)

The supported, token-authenticated HTTP API for agents and integrations. It is
declared once in code, in `src/server/public-api/registry.ts`; the OpenAPI 3.1
document, the route mounting and the contract tests are all generated from or
checked against that registry.

- Machine-readable spec: `GET /api/v1/openapi.json` (authenticated, see below).
- Agents can read and prepare. They can never approve or execute an external
  write: no endpoint here sends anything, and approval stays a human act inside
  Trevra.

## Supported endpoints

| Method | Path                            | Scope            | Rate class | Purpose                                                  |
| ------ | ------------------------------- | ---------------- | ---------- | -------------------------------------------------------- |
| GET    | `/api/agent/skills`             | `skills:read`    | read       | Skills this Agent may run, with input/output schemas     |
| POST   | `/api/agent/skills/:id/run`     | `skills:run`     | write      | Run a pure-computation or network-read skill             |
| GET    | `/api/agent/runs`               | `runs:read`      | read       | Recent skill runs                                        |
| GET    | `/api/agent/runs/:id`           | `runs:read`      | read       | One skill run                                            |
| GET    | `/api/agent/playbooks`          | `playbooks:read` | read       | Playbooks and their workspace enablement                 |
| POST   | `/api/agent/playbooks/:id/runs` | `playbooks:run`  | write      | Start a durable playbook run                             |
| GET    | `/api/agent/playbook-runs`      | `workflows:read` | read       | Playbook runs; `?status=waiting_approval` for pending    |
| GET    | `/api/agent/playbook-runs/:id`  | `workflows:read` | read       | One run with step-level approval status and payload hash |
| GET    | `/api/agent/events`             | `workflows:read` | read       | Append-only domain events, paged with `afterPosition`    |
| GET    | `/api/agent/people`             | `workspace:read` | read       | People (leads)                                           |
| GET    | `/api/agent/accounts`           | `workspace:read` | read       | Ranked target Accounts with recent signals               |
| GET    | `/api/agent/opportunities`      | `workspace:read` | read       | Opportunities                                            |
| GET    | `/api/agent/conversations`      | `workspace:read` | read       | Person-led conversations across email and LinkedIn       |
| GET    | `/api/agent/deliveries`         | `workspace:read` | read       | Email delivery outcomes                                  |
| POST   | `/api/agent/mcp`                | `skills:read`    | see below  | MCP Streamable HTTP (stateless)                          |
| GET    | `/api/agent/mcp`                | `skills:read`    | read       | Always 405 (JSON-RPC error): use POST                    |
| DELETE | `/api/agent/mcp`                | `skills:read`    | read       | Always 405 (JSON-RPC error): no session to end           |
| GET    | `/api/v1/openapi.json`          | any valid token  | read       | The OpenAPI 3.1 document                                 |

The five `workspace:read` endpoints are REST forms of the existing MCP tools
(`trevra_list_people`, `trevra_list_accounts`, ...). They call the same tool
function with the same scope check, so the two transports cannot drift.

**Everything else is internal.** Browser-session routes (for example
`/api/agent-tokens`, `/api/agent-runs`, `/api/outbound-webhooks`, playbook
approval decisions, LinkedIn campaigns and lead lists), the LinkedIn companion
device routes, inbound provider webhooks (`/api/webhooks/*`), admin routes and
the unauthenticated public catalog (`/api/public/*`) are not part of this API.
They may change without notice, and an agent token presented to a session route
is answered with `401`.

## Authentication

Send an Agent token as a bearer credential:

```http
Authorization: Bearer trv_live_...
```

A workspace member creates tokens in Trevra or with `POST /api/agent-tokens`
from a signed-in session. A token belongs to exactly one workspace and one
Agent, carries explicit scopes, and can expire or be revoked. Every request is
answered from that workspace only: a resource id from another workspace returns
`404 not_found`, never the resource.

Scopes: `skills:read`, `skills:run`, `runs:read`, `workspace:read`,
`playbooks:read`, `playbooks:run`, `workflows:read`. There is no approve,
execute, billing or integration-admin scope. A missing scope returns
`403 insufficient_scope`.

`GET /api/v1/openapi.json` additionally accepts a signed-in browser session, so
the spec can be opened from the app. It is not linked from `robots.txt`,
`sitemap.xml`, `llms.txt` or `agents.md`.

## Errors

Every error from a supported endpoint uses one envelope:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request validation failed",
    "requestId": "5b0f6c3e-2f1d-4f8a-9a59-0f7c3c1e2d44",
    "details": [
      {
        "location": "query",
        "field": "limit",
        "code": "too_small",
        "message": "Number must be greater than or equal to 1"
      }
    ]
  }
}
```

Branch on `code` (stable snake_case) and the HTTP status, not on `message`.
`details` appears only on `validation_failed`.

| Status | Codes                                                                               |
| ------ | ----------------------------------------------------------------------------------- |
| 400    | `validation_failed` (with `details`), `invalid_json`, `invalid_request`             |
| 401    | `unauthenticated` (also sends `WWW-Authenticate: Bearer`)                           |
| 403    | `insufficient_scope`, `skill_not_assigned`, `origin_not_allowed`, `forbidden`       |
| 404    | `not_found`                                                                         |
| 405    | `method_not_allowed` (with `Allow`)                                                 |
| 409    | `conflict` (for example an external-write skill, or a prepared-only playbook)       |
| 413    | `payload_too_large`                                                                 |
| 415    | `unsupported_media_type`                                                            |
| 422    | `unprocessable_entity`                                                              |
| 429    | `rate_limited`                                                                      |
| 5xx    | `internal_error`, `service_unavailable`: fixed message, no stack or internal detail |

New codes may be added within v1; treat an unknown code by its HTTP status.

MCP exception: `POST /api/agent/mcp` returns JSON-RPC bodies as the MCP
specification defines (including tool errors). The envelope applies there only
to authentication, scope, rate-limit and transport failures.

### Request ids

Every response carries `X-Request-Id`, and every error repeats it as
`error.requestId`. Send your own `X-Request-Id` to correlate: a value matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` is echoed; anything else is replaced with
a new UUID. Quote it when reporting a problem.

## Rate limits

Limits are fixed one-minute windows shared by every API instance (PostgreSQL
counters), charged per token and per workspace, with a lower budget for writes:

| Class | Per token / minute | Per workspace / minute |
| ----- | ------------------ | ---------------------- |
| read  | 120                | 600                    |
| write | 30                 | 120                    |

- `write` is `POST /api/agent/skills/:id/run` and
  `POST /api/agent/playbooks/:id/runs`. On `POST /api/agent/mcp` each JSON-RPC
  `tools/call` is one write, so a batch of N calls costs N writes (and a batch
  larger than the remaining budget is refused whole); a request with no
  `tools/call` is one read.
- Every authenticated request is charged, including ones later refused with
  4xx. A request refused by its own token limit is not charged to the
  workspace, so one runaway token cannot exhaust other tokens' budget.
- Responses after authentication carry:
  - `X-RateLimit-Limit`: the limit of the binding bucket (the one that refused,
    otherwise whichever of token/workspace has less left);
  - `X-RateLimit-Remaining`: requests left in that bucket this window;
  - `X-RateLimit-Reset`: Unix time in seconds when the window ends.
- Over the limit: `429 rate_limited` with `Retry-After` (seconds).
- Independently, every `/api` request without a browser session cookie (token
  traffic included) is also capped per client address at 300 per minute. That
  guard reports draft `RateLimit-*` headers and answers these endpoints with
  the same `429 rate_limited` envelope.

## Idempotency

- `GET` requests are safe and can be retried freely.
- The two `POST` endpoints are **not idempotent** in v1 and do not read an
  `Idempotency-Key` header: each accepted call records a new skill run or starts
  a new playbook run. If a `POST` times out, check `GET /api/agent/runs` or
  `GET /api/agent/playbook-runs` before retrying.
- A request refused by authentication, scope, rate limiting or request
  validation (`401`, `403 insufficient_scope`, `405`, `429`,
  `400 validation_failed` / `invalid_json`) changed nothing and is safe to retry
  once the cause is fixed.
- Nothing in this API performs an external write. Consequential actions are
  prepared inside Trevra, approved by a human against an exact payload hash, and
  executed with deterministic idempotency keys there.

## Versioning

- This is v1. `info.version` in the OpenAPI document follows semver: minor and
  patch releases are backward compatible.
- Backward-compatible changes ship within v1: new endpoints, new optional
  request fields or query parameters, new response fields (documented objects
  allow additional properties; ignore fields you do not know), new error codes.
- Breaking changes (removing or renaming an endpoint or field, changing a
  type, tightening validation, changing auth or scopes) only ship in a new major
  version under a new prefix (`/api/v2/...`, with its own
  `/api/v2/openapi.json`). v1 paths keep working during an announced overlap
  period.
- Routes outside this document carry no compatibility promise.

## Example

```bash
export TREVRA_API_URL=https://app.example.com
export TREVRA_AGENT_TOKEN=trv_live_...

# Fetch the spec
curl -sS "$TREVRA_API_URL/api/v1/openapi.json" \
  -H "Authorization: Bearer $TREVRA_AGENT_TOKEN"

# Run a skill, with your own request id for correlation
curl -sS -i -X POST "$TREVRA_API_URL/api/agent/skills/gtm.score-lead/run" \
  -H "Authorization: Bearer $TREVRA_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: my-job-42" \
  -d '{"lead":{"platform":"shopify","vertical":"footwear","catalogSize":100}}'

# Find playbook runs waiting on a human decision
curl -sS "$TREVRA_API_URL/api/agent/playbook-runs?status=waiting_approval" \
  -H "Authorization: Bearer $TREVRA_AGENT_TOKEN"
```

## Not yet in the public API

- LinkedIn campaigns, lead lists and campaign statistics: browser-session only.
- Outbound webhook subscription management: workspace-owner session only.
- `Idempotency-Key` support on `POST`.
- Cursor pagination (lists take `limit`; events page with `afterPosition`).
- Per-workspace or per-plan limit overrides.
