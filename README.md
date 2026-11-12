# Sail

A multi-brand, multi-outlet restaurant POS built as a small deterministic register (the API) that humans and agents press the buttons of. Scope, roadmap, vision and design live in `docs/`.

| Package | What |
|-|-|
| `packages/shared` | Zod schemas, roles and permission matrix, the operation manifest, money helpers and the **pricing pipeline** (pure). |
| `packages/server` | Hono API (`/v1`), Drizzle schema and migrations, worker, SSE, MCP adapter. One image, role flags. |
| `packages/web` | Next.js: back office and the iPad POS. |
| `packages/ui` | Sail's own component package and design tokens (Day and Service themes). |
| `packages/guest` | Scan to Order guest app (phones). |
| `packages/relay` | Print relay for network ESC/POS printers at each outlet. |

## Quick start

```bash
corepack enable && pnpm install
pnpm --filter @sail/server dev:local     # embedded Postgres + API on :8080, Admin admin@sail.local / PIN 123456
pnpm --filter @sail/web dev              # back office on :3000: sign in as admin@sail.local, password sail-demo-password
pnpm test                                # shared + server test suites
```

On a real database with no merchant yet, the back office opens on first-run setup: your business, a region preset, the first outlet and your Admin login. `docs/sign-in.md` covers setup, the CLI bootstrap for headless installs, inviting staff and the external identity provider option.

See `docs/how-to.md` for adding routes, tables and migrations, and `docs/completions/` for what each phase delivered and what is blocked.
