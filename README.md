# Resolve

Resolve is a private Zendesk Support app whose assistant, Słones, gives agents a ticket-aware Claude chat. It retrieves cited customer, order, shipment, tracking, voicemail, prior-ticket, and workflow information without leaving the active ticket.

Resolve 1.1 adds bounded ShipStation phone lookup, Zendesk voicemail transcription through Workers AI, administrator-managed Markdown workflow knowledge, and confirmed Zendesk custom-field/customer-profile updates. Writes are limited to reviewed allowlists and require a dedicated confirmation click; free-form chat cannot execute them.

## Architecture

- `apps/zendesk`: React and ZAF v2 ticket-sidebar app.
- `workers/orchestrator`: authenticated Cloudflare Worker, Anthropic tool loop, D1 history, Workers AI, R2, Vectorize, Queue-backed indexing, and 90-day retention.
- `packages/contracts`: schemas shared across the iframe and Worker.
- `packages/skill-sdk`: versioned skill and tool contracts with enforced risk policy.
- `packages/skills`: Zendesk, WooCommerce, and ShipStation v1/v2 skill packs.

Zendesk secure installation settings are inserted into allow-listed Worker request headers by Zendesk's proxy. The browser cannot read the secret values, and the Worker does not persist them.

For this installation, Resolve maps the active ticket brand to one of two isolated WooCommerce connections: Solution Peptides (`solutionpeptides.net`) or Atomik Labz (`atomiklabz.com`). Unknown brands are rejected instead of searched across stores.

Zendesk administrators select Słones's Claude model and effort level in Resolve's installation settings. The in-app Settings view shows the active values. The interface uses JetBrains Mono throughout.

Single-tenant visible settings are preconfigured. Zendesk deliberately hides secure values after saving them; private-app updates preserve those values, while the backend token remains a one-time manual secret.

Knowledge administration is separate from the Zendesk app at `https://<worker-host>/admin/knowledge`. Protect `/admin/*` with a Cloudflare Access self-hosted application and an administrator-only policy. The Worker validates the Access JWT's issuer, audience, signature, and time claims; the Zendesk backend token cannot authorize admin routes.

## Requirements

- Node.js 22 or newer
- Corepack
- A Cloudflare account for deployment
- A D1 database, R2 bucket, 1,024-dimension cosine Vectorize index, Queue, Workers AI access, and Cloudflare Access policy
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
pnpm worker:dry-run
pnpm --filter @resolve/zendesk-app package:zip
```

ZCLI validation and packaging are local and do not publish the app, but this ZCLI version requires Zendesk environment credentials or an interactive login:

```bash
pnpm zaf:validate
pnpm zaf:package
```

See:

- [Deployment](docs/deployment.md)
- [Adding and managing skills](docs/skills.md)
- [Testing](docs/testing.md)
- [Approved design](docs/superpowers/specs/2026-07-18-resolve-zendesk-app-design.md)
