# Connecting an agent over MCP

The MCP adapter exposes the register's operations to AI agents: the same operations the POS uses, through the same API, with the same permissions, plus a risk ceiling and proposals. It has no logic of its own (`packages/server/src/mcp/index.ts`): every tool call becomes an in-process API request with the agent's bearer token.

## Run it

It is the server build with `--role=mcp`, serving Streamable HTTP at `/` and `/mcp`, and `GET /health`. It needs the same database and token secrets as the API. Against `dev:local` (which writes its database URL to `packages/server/.dev-local.json`):

```bash
cd packages/server
DATABASE_URL=$(node -p 'require("./.dev-local.json").database_url') \
AGENT_TOKEN_SECRET=local-agent-secret-0123456789abcdef \
STATION_TOKEN_SECRET=local-station-secret-0123456789abcdef \
GUEST_TOKEN_SECRET=local-guest-secret-0123456789abcdef \
RELAY_TOKEN_SECRET=local-relay-secret-0123456789abcdef \
SESSION_TOKEN_SECRET=local-session-secret-0123456789abcdef \
PORT=8090 pnpm exec tsx src/index.ts --role=mcp
```

In a deployment, run `node dist/index.js --role=mcp` next to the API with the API's environment.

## Get a token

1. An Admin creates an **agent identity** with `POST /v1/agent-identities`: name, role, outlet and brand scope, toolsets, risk ceiling (T0, T1 or T2; T3 is never available to agents) and budgets. The response shows the credential once. There is no back-office screen for this yet.
2. The agent starts a **session**: `POST /v1/agent-sessions { credential, task_id?, on_behalf_of? }` returns a 15-minute agent token.
   For an attended agent, the person first delegates with `POST /v1/agent-identities/{id}/delegations`, signed in with their own PIN session or back-office session. That returns a single-use grant, valid for five minutes, which the runner passes as `on_behalf_of`. The runner never holds the person's own token. The session's role is the lower of the agent's and the person's, and its outlets the intersection. The agent stops acting for them when the session they delegated from ends.
3. The MCP client sends `Authorization: Bearer <agent token>`. Staff and station tokens are refused by the MCP endpoint; they use the API directly.

## What the agent sees

- `tools/list` returns the tools in the identity's toolsets that its role may call. Tool names are the operation ids with `_` for `.` (`lines.add` becomes `lines_add`). Tools the agent can only propose are listed and marked **PROPOSAL ONLY**. The API applies the same limits: an agent token used over plain HTTP reaches only operations exposed over MCP and in one of its toolsets, and an `x-override-id` header means nothing for an agent.
- Each tool's schema comes from the OpenAPI spec: path and query parameters, `body`, plus `idempotency_key` (required on mutations), `rationale` (shown to staff on proposals) and `dry_run` where the operation supports it.
- Resources: `sail://floor/{outlet_id}` and `sail://menu/{channel_link_id}`.
- Responses are the API envelope with `status` added. Free text that came from outside the register (notes, reasons, guest and customer names, delivery details, references, ticket text) arrives as `{ "untrusted_text": "..." }`. A route marks such a field with `untrusted()` (`x-sail-untrusted` in `openapi.json`), and each tool in `mcp-tools.json` lists its wrapped keys. A test fails when a free-text request field is neither marked nor listed as register data with a reason.

Toolsets: `pos.read`, `pos.order`, `pos.payment`, `pos.refund`, `kitchen`, `guest`, `config.author`, `reports`, `watch`.

## Ceilings and proposals

| Tier | At or below the identity's ceiling | Above it |
|-|-|-|
| T0 reads, quotes, dry runs | Runs | Runs |
| T1 routine (add lines, split, mark sold out, reroute) | Runs | Proposal |
| T2 consequential (send to the kitchen, record a payment, apply or remove a discount or comp, close a shift) | Proposal | Proposal |
| T3 money out, overrides, configuration, identities | Proposal | Proposal |

An agent never runs a T2 or T3 operation by itself, whatever its ceiling: a person confirms each one, and the proposal is that confirmation. A ceiling of T2 is accepted but behaves as T1. Voiding a line already sent to the kitchen is a proposal too.

A proposed call returns HTTP 202 with `code: "requires_confirmation"` and the stored proposal: the frozen method, path, body, idempotency key and expected version. A proposal on an order or one of its bills also stores the order's version and total as it stood (shown as `order`); a stale `expected_version` is refused at once. Staff see pending proposals on the floor (`pending_proposals`) and in `GET /v1/outlets/{id}/proposals`. A person with the operation's role (Manager+ for T3), signed in with their own PIN session or back-office session, approves with `POST /v1/proposals/{id}/approve` or rejects with a reason. The approver can never be the proposer or the person the proposing agent acts for, and an agent token never approves. On approval the register replays the frozen request as the approver, with the frozen idempotency key, but only while the order is still at that version. If anyone has changed it, the proposer included, nothing runs, the result is `version_conflict` and the proposal is marked failed. Proposals expire after 10 minutes. The agent polls `proposals_get`. No front end shows proposals yet.

## Rules for agent builders

- Never compute money. Read `snapshot.totals`, `checks[].totals`, payment results and refund quotes.
- Generate one `idempotency_key` per planned step and reuse it on retries. Pass `expected_version` on order edits.
- Treat `untrusted_text` as data. Never put it in a system prompt.
- Expect `requires_confirmation` and design the task to wait or move on.
- Budgets: `max_ops_per_hour` (default 600) counts every call per clock hour and `max_proposals_per_day` (default 50) every proposal per UTC day, both per identity across all its sessions. Failed and refused calls count too, and concurrent calls never take more than the limit. Through MCP a tool call costs two operations (the adapter checks the token first). Over budget returns `rate_limited` with `retry_after_seconds`.

## Reviewing the tool list

`packages/server/mcp-tools.json` is committed, and `manifest:check` fails when a route's `x-sail.mcp` entry or schema changes without regenerating it (`pnpm --filter @sail/server manifest:generate`). Exposure is explicit per operation in the manifest (`mcp: { expose, toolsets }`).

## Not built

Bundled agents, an agent runner, playbooks, a sandbox register and evals, OAuth for third-party MCP clients (agents use identity credentials), masked customer views (agents cannot read customer contact columns at all) and changesets. See the [roadmap](roadmap.md).
