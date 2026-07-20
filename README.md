# Resolve

Resolve is a private Zendesk Support app whose assistant, Słones, gives agents a ticket-aware Claude chat. It retrieves cited customer, order, shipment, tracking, and prior-ticket information from Zendesk, WooCommerce, and ShipStation without leaving the active ticket.

The current milestone is intentionally read-only. Profile creation, profile merges, shipment tags, shipping-method changes, and every other mutation remain disabled until a later confirmed-write milestone.

## Architecture

- `apps/zendesk`: React and ZAF v2 ticket-sidebar app.
- `workers/orchestrator`: authenticated Cloudflare Worker, Anthropic tool loop, D1 history, and 90-day retention.
- `packages/contracts`: schemas shared across the iframe and Worker.
- `packages/skill-sdk`: versioned skill and tool contracts with enforced risk policy.
- `packages/skills`: Zendesk, WooCommerce, and ShipStation v1/v2 skill packs.

Zendesk secure installation settings are inserted into allow-listed Worker request headers by Zendesk's proxy. The browser cannot read the secret values, and the Worker does not persist them.

For this installation, Resolve maps the active ticket brand to one of two isolated WooCommerce connections: Solution Peptides (`solutionpeptides.net`) or Atomik Labz (`atomiklabz.com`). Unknown brands are rejected instead of searched across stores.

Zendesk administrators select Słones's Claude model and effort level in Resolve's installation settings. The in-app Settings view shows the active values. The interface uses JetBrains Mono throughout.

## Requirements

- Node.js 22 or newer
- Corepack
- A Cloudflare account for deployment
- A Zendesk test or production account for private-app installation
- Anthropic, WooCommerce, and ShipStation credentials for enabled integrations

## Local setup

```bash
corepack enable
pnpm install
copy workers\orchestrator\.dev.vars.example workers\orchestrator\.dev.vars
pnpm test
pnpm typecheck
pnpm build
```

Update `.dev.vars` locally. Never commit real tokens.

Run the Worker locally:

```bash
pnpm --filter @resolve/orchestrator exec wrangler d1 migrations apply resolve --local
pnpm --filter @resolve/orchestrator exec wrangler dev
```

The Zendesk app build is written to `apps/zendesk/dist`.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm skills:validate
pnpm build
pnpm worker:types:check
```

ZCLI validation and packaging require Zendesk authentication:

```bash
pnpm zaf:validate
pnpm zaf:package
```

See:

- [Deployment](docs/deployment.md)
- [Adding and managing skills](docs/skills.md)
- [Testing](docs/testing.md)
- [Approved design](docs/superpowers/specs/2026-07-18-resolve-zendesk-app-design.md)
