# Deployment

## 1. Verify locally

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm skills:validate
pnpm build
pnpm worker:types:check
pnpm worker:dry-run
pnpm zaf:validate
pnpm zaf:package
pnpm --filter @resolve/zendesk-app package:zip
git diff --check
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
pnpm --filter @resolve/orchestrator exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
pnpm --filter @resolve/orchestrator exec wrangler secret put CF_ACCESS_AUD
pnpm --filter @resolve/orchestrator exec wrangler secret put PHONE_CACHE_HMAC_KEY
```

`TENANT_KEY` should match the `zendesk_subdomain` installation setting. `PHONE_CACHE_HMAC_KEY` must be a separate high-entropy value used for the HMAC lookup key and HKDF-derived AES-256-GCM payload key. Phone-cache payloads contain only a versioned nonce/ciphertext envelope at rest. Rotating this value intentionally invalidates all existing cache rows; they become safe cache misses and are repopulated from ShipStation. Required values are declared in `wrangler.jsonc`.

The two WooCommerce values pin the Solution Peptides and Atomik Labz HTTPS origins. Enter the matching origins in Zendesk. The Worker resolves the active ticket brand, selects only that brand's credentials, and rejects origin mismatches before forwarding secrets.

For Cloudflare Access, set `CF_ACCESS_TEAM_DOMAIN` to the team hostname only (for example, `resolve.cloudflareaccess.com`, without a scheme or path). Set `CF_ACCESS_AUD` to the Access application's audience tag.

## 4. Provision Cloudflare resources

Provision these resources once before the first 1.1 deployment:

```bash
pnpm --filter @resolve/orchestrator exec wrangler r2 bucket create resolve-knowledge
pnpm --filter @resolve/orchestrator exec wrangler vectorize create resolve-knowledge --dimensions=1024 --metric=cosine
pnpm --filter @resolve/orchestrator exec wrangler vectorize create-metadata-index resolve-knowledge --propertyName=brand --type=string
pnpm --filter @resolve/orchestrator exec wrangler vectorize create-metadata-index resolve-knowledge --propertyName=workflowCategory --type=string
pnpm --filter @resolve/orchestrator exec wrangler queues create resolve-knowledge-index
```

The Vectorize dimensions and distance metric are immutable index properties and must match the `@cf/qwen/qwen3-embedding-0.6b` output used by the Worker. Both metadata indexes are required because filtered searches query `brand` and `workflowCategory`. Wait for metadata indexes to become ready before testing filtered retrieval.

`wrangler.jsonc` binds:

- D1 as `DB`;
- Workers AI as `AI`;
- R2 as `KNOWLEDGE_BUCKET`;
- Vectorize as `KNOWLEDGE_INDEX`;
- the producer/consumer Queue as `KNOWLEDGE_INDEX_QUEUE`;
- the native rate limiter as `REQUEST_LIMITER`.

The Queue consumer intentionally uses `max_batch_size: 1` and `max_concurrency: 2`. The explicit conservative concurrency allows limited parallel indexing while bounding simultaneous 5 MiB R2 reads, chunking, Workers AI embeddings, Vectorize writes, and D1 work. Do not create a second consumer for the same Worker/configuration.

## 5. Apply D1 migrations

The production D1 database ID is pinned in `wrangler.jsonc`. Apply remote migrations before deploying code that depends on them:

```bash
pnpm worker:dry-run
pnpm --filter @resolve/orchestrator exec wrangler d1 migrations apply resolve --remote
```

For the 1.1 release, verify Wrangler applies these new migrations in lexical order:

1. `0003_operations_expansion.sql` — hashed ShipStation phone cache.
2. `0004_write_proposals.sql` — expiring confirmation proposals.
3. `0005_knowledge.sql` — versioned knowledge documents and chunks.

Do not deploy the 1.1 Worker until all three migrations have applied successfully.

## 6. Configure Cloudflare Access

Create a self-hosted Access application for `https://<worker-host>/admin/*` and attach an administrator-only Allow policy. Do not protect the entire Worker hostname: Zendesk must still reach bearer-authenticated `/health` and `/v1/*` routes without an Access session.

Copy the application's audience tag into `CF_ACCESS_AUD` and the team hostname into `CF_ACCESS_TEAM_DOMAIN`. The Worker independently verifies `Cf-Access-Jwt-Assertion`; configuring an Access policy without these matching values is insufficient.

Admin portal URL:

```text
https://<worker-host>/admin/knowledge
```

## 7. Build and validate the Zendesk app

Validation and packaging are local operations and do not publish a release. This ZCLI version still requires `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, and `ZENDESK_API_TOKEN`, or an interactive `pnpm exec zcli login -i` session:

```bash
pnpm --filter @resolve/zendesk-app build
pnpm zaf:validate
pnpm zaf:package
pnpm --filter @resolve/zendesk-app package:zip
```

The package script uses Zendesk ZCLI's Archiver implementation and writes `Resolve-v<version>-zendesk.zip` under `apps/zendesk/dist/tmp/`.

The local ZCLI server does not substitute secure settings. Use an installed app in a Zendesk test account to verify the real proxy-injection path.

## 8. Deploy only after approval

```bash
pnpm worker:dry-run
pnpm --filter @resolve/orchestrator exec wrangler deploy
```

After deployment, verify unauthenticated `/health` is `401`, authenticated `/health` is `200`, the admin URL requires Access, and the Worker reports the configured D1, AI, R2, Vectorize, Queue, and rate-limit bindings. Deployment and publication require separate approval from local release preparation.

## 9. Enter installation settings

Visible settings:

- Worker URL: the deployed `https://...workers.dev` URL.
- Worker hostname: the same host without `https://`.
- Zendesk subdomain: the account subdomain and Cloudflare `TENANT_KEY`.
- Słones Claude model: a supported identifier such as `claude-sonnet-5`.
- Słones effort: `low`, `medium`, `high`, `xhigh`, or `max`; `medium` is the default.
- Solution Peptides WooCommerce URL: `https://solutionpeptides.net`.
- Atomik Labz WooCommerce URL: `https://atomiklabz.com`.
- ShipStation mode: `v2`, `v1`, or `auto`.

Resolve preconfigures the Worker URL, hostname, `solutionpeptides` subdomain, both WooCommerce origins, model, effort, and ShipStation `auto` mode for this single-tenant installation.

Secure settings:

- Backend auth token: the value stored in `BACKEND_AUTH_TOKEN`.
- Anthropic API key.
- Solution Peptides WooCommerce consumer key and secret.
- Atomik Labz WooCommerce consumer key and secret.
- ShipStation v2 key and/or legacy v1 key and secret.

WooCommerce keys should be read-only for the MVP. Resolve does not need a Zendesk API token because delegated ticket reads use the current agent's ZAF session.

Zendesk intentionally shows secure settings as blank after they are saved and does not expose their stored values to the app. Private-app updates preserve existing secure values. The backend token cannot be safely embedded or auto-filled because doing so would publish it in the ZIP; copy it from the git-ignored `workers/orchestrator/.dev.vars` only during installation or rotation.

## 10. Smoke test

1. Open a non-production test ticket.
2. Confirm the wide Resolve panel loads requester context.
3. Run one WooCommerce lookup on a Solution Peptides ticket.
4. Run one WooCommerce lookup on an Atomik Labz ticket and verify records never cross stores.
5. Run one ShipStation lookup for every configured API generation.
6. Retrieve one prior Zendesk ticket.
7. Open every returned citation.
8. Search by a synthetic caller phone number and verify the completeness status and linked order.
9. Retrieve a synthetic voicemail and verify existing-text fallback plus Workers AI transcription on a separate record.
10. Upload synthetic Markdown through the Access-protected admin URL, wait for indexed status, and verify filename/heading citations.
11. Propose a synthetic allowed Zendesk update; verify no PUT occurs before the dedicated click, then confirm and verify the refetched state.
12. Verify stale and expired proposals cannot execute.
13. Confirm a Zendesk backend token cannot open or upload through `/admin/*`.
14. Reload as another authorized agent and confirm history persists.
15. Invalidate one test credential and confirm Resolve reports a safe configuration error without showing the value.
16. Inspect Worker logs for request IDs, durations, statuses, and no message bodies, credentials, raw audio, or plaintext phone-cache keys.

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
