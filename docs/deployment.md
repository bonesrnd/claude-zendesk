# Deployment

## 1. Verify locally

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm skills:validate
pnpm build
```

## 2. Authenticate Wrangler

```bash
pnpm --filter @resolve/orchestrator exec wrangler login
pnpm --filter @resolve/orchestrator exec wrangler whoami
```

## 3. Configure Worker secrets

Generate one high-entropy backend token. Enter the same token in Cloudflare and the Zendesk app installation. Do not store it in a tracked file.

```bash
pnpm --filter @resolve/orchestrator exec wrangler secret put BACKEND_AUTH_TOKEN
pnpm --filter @resolve/orchestrator exec wrangler secret put TENANT_KEY
pnpm --filter @resolve/orchestrator exec wrangler secret put WOO_SOLUTION_PEPTIDES_BASE_URL
pnpm --filter @resolve/orchestrator exec wrangler secret put WOO_ATOMIK_LABZ_BASE_URL
```

`TENANT_KEY` should match the `zendesk_subdomain` installation setting. Required values are declared in `wrangler.jsonc`, so deployment fails if any is absent.

The two WooCommerce values pin the Solution Peptides and Atomik Labz HTTPS origins. Enter the matching origins in Zendesk. The Worker resolves the active ticket brand, selects only that brand's credentials, and rejects origin mismatches before forwarding secrets.

## 4. Provision and migrate D1

The production D1 database ID is pinned in `wrangler.jsonc`. Apply remote migrations before deploying code that depends on them:

```bash
pnpm worker:dry-run
pnpm --filter @resolve/orchestrator exec wrangler d1 migrations apply resolve --remote
pnpm --filter @resolve/orchestrator exec wrangler deploy
```

Run the migration command for every new migration before serving code that requires it.

## 5. Build and validate the Zendesk app

Authenticate ZCLI without putting credentials in project files:

```bash
pnpm exec zcli login -i
pnpm --filter @resolve/zendesk-app build
pnpm zaf:validate
pnpm zaf:package
```

ZCLI writes the installation ZIP under `apps/zendesk/dist/tmp/`.

The local ZCLI server does not substitute secure settings. Use an installed app in a Zendesk test account to verify the real proxy-injection path.

## 6. Enter installation settings

Visible settings:

- Worker URL: the deployed `https://...workers.dev` URL.
- Worker hostname: the same host without `https://`.
- Zendesk subdomain: the account subdomain and Cloudflare `TENANT_KEY`.
- Anthropic model: a supported Claude model identifier.
- Solution Peptides WooCommerce URL: `https://solutionpeptides.net`.
- Atomik Labz WooCommerce URL: `https://atomiklabz.com`.
- ShipStation mode: `v2`, `v1`, or `auto`.

Secure settings:

- Backend auth token: the value stored in `BACKEND_AUTH_TOKEN`.
- Anthropic API key.
- Solution Peptides WooCommerce consumer key and secret.
- Atomik Labz WooCommerce consumer key and secret.
- ShipStation v2 key and/or legacy v1 key and secret.

WooCommerce keys should be read-only for the MVP. Resolve does not need a Zendesk API token because delegated ticket reads use the current agent's ZAF session.

## 7. Smoke test

1. Open a non-production test ticket.
2. Confirm the wide Resolve panel loads requester context.
3. Run one WooCommerce lookup on a Solution Peptides ticket.
4. Run one WooCommerce lookup on an Atomik Labz ticket and verify records never cross stores.
5. Run one ShipStation lookup for every configured API generation.
6. Retrieve one prior Zendesk ticket.
7. Open every returned citation.
8. Reload as another authorized agent and confirm history persists.
9. Invalidate one test credential and confirm Resolve reports a safe configuration error without showing the value.
10. Inspect Worker logs for request IDs, durations, statuses, and no message bodies or credentials.

## Rollback

Worker:

```bash
pnpm --filter @resolve/orchestrator exec wrangler versions list
pnpm --filter @resolve/orchestrator exec wrangler rollback
```

Zendesk:

- Keep the previously validated private-app ZIP.
- Upload it as the next private-app update if a rollback is needed.
- Do not convert a regular Zendesk setting to secure or vice versa; Zendesk requires a new setting name for that change.
