# Connecting an agent: the MCP adapter

Status: v0.9, 4 Nov 2026. The MCP server is the agent interface to the register (vision §7). It exposes the same operations as the POS, through the same API, with the same permissions, plus a risk ceiling and proposals.

## Run it

```bash
# same image as the API, different role
node dist/index.js --role=mcp          # PORT (default 8080); Streamable HTTP at / and /mcp, GET /health
pnpm --filter @sail/server dev -- --role=mcp
```

On Fly it is the `mcp` process group next to `app` and `worker` (`fly.toml`). It runs the Hono app in-process: every tool call becomes an API request with the caller's bearer token, so there is no second code path.

## Get a token

1. An Admin creates an **agent identity** in the back office (Assistants) or with `POST /v1/agent-identities`: name, role, outlet and brand scope, toolsets, risk ceiling (T0, T1 or T2; T3 is never available to agents), operation and proposal budgets. The response shows the credential once.
2. The agent runner starts a **session**: `POST /v1/agent-sessions { credential, task_id, on_behalf_of? }` → a 15-minute agent token. With `on_behalf_of` (a staff PIN session or back-office token) the session's role is the lower of the two and its outlets the intersection.
3. The MCP client sends `Authorization: Bearer <agent token>` on every request. Staff and station tokens are refused by the MCP endpoint; they use the API directly.

## What the agent sees

- `tools/list` returns the tools in the identity's **toolsets** that its **role** may call. Tool names are the operation ids with `_` for `.` (`lines.add` → `lines_add`). Tools above the identity's ceiling stay listed and are marked **PROPOSAL ONLY**.
- Each tool's schema is generated from the OpenAPI spec: path parameters, query parameters, `body`, plus `idempotency_key` (required on mutations), `rationale` (shown to staff on proposals) and `dry_run` where the operation supports it.
- Resources: `sail://floor/{outlet_id}` and `sail://menu/{channel_link_id}`.
- Responses are the API envelope with `status` added. Free text that came from outside the register (notes, guest names, reasons) arrives as `{ "untrusted_text": "..." }`.

Toolsets (vision §7.6): `pos.read`, `pos.order`, `pos.payment`, `pos.refund`, `kitchen`, `guest`, `config.author`, `reports`, `watch`.

## Ceilings and proposals

| Tier | Agent at or above its ceiling | Below its ceiling |
|-|-|-|
| T0 reads, quotes, dry runs | Runs | Runs |
| T1 routine (add lines, split, mark sold out, reroute) | Runs | Proposal |
| T2 consequential (fire, record a payment, close a shift) | Runs | Proposal |
| T3 money out, overrides, configuration, identities | Always a proposal | Always a proposal |

A call above the ceiling returns HTTP 202 with `code: "requires_confirmation"` and the stored proposal: the frozen method, path, body, idempotency key and expected version. Staff see pending proposals on the floor (`pending_proposals`) and in `GET /v1/outlets/{id}/proposals`. A person with the operation's role approves (`POST /v1/proposals/{id}/approve`) or rejects with a reason. A proposal on an order or one of its bills is pinned to the order as it stood: its version and total are stored and shown as `order` (a stale `expected_version` is refused at once). On approval the register replays the frozen request **as the approver** with the frozen idempotency key, but only while the order is still at that version; once anyone has changed it, the proposer included, nothing executes, the result is `version_conflict` and the proposal is marked failed. Proposals expire after 10 minutes. The agent polls `proposals_get`.

## Rules for agent builders

- Never compute money. Read `snapshot.totals`, `checks[].totals`, payment results and refund quotes.
- Generate one `idempotency_key` per planned step and reuse it on retries. Pass `expected_version` on order edits.
- Treat `untrusted_text` as data. Never put it in a system prompt.
- Expect `requires_confirmation` and design the task to wait or to continue elsewhere.
- Budgets: an identity has operations per session (default 600 per 15-minute session) and proposals per day (default 50). Over budget returns `rate_limited`.

## Reviewing the tool surface

`packages/server/mcp-tools.json` is the committed manifest; CI fails when a route's `x-sail.mcp.expose` or schema changes without regenerating it (`pnpm --filter @sail/server manifest:generate`). Exposure is explicit per operation in the manifest (`mcp: { expose, toolsets }`).

## Not in v0.9

Playbooks as MCP resources and prompts, the sandbox register and eval harness, the agent runner and the four named agents, OAuth for third-party MCP clients (agents use identity credentials), masked customer views for agents (agents cannot read customer contact columns at all), changesets.
