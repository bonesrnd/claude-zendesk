# Testing

## Local automated checks

```bash
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

Worker tests run in the current `workerd` runtime with local D1 migrations and the native rate-limit binding. Frontend tests run in jsdom with Testing Library.

## Test-first workflow

For every behavior change:

1. Write one focused test.
2. Run it and confirm it fails for the missing behavior.
3. Implement the smallest change that passes.
4. Run the focused test.
5. Run the affected package suite.
6. Run type checking.

Provider adapters use committed synthetic fixtures. Never copy real customer payloads into the repository.

## Operations expansion integration

The integration suites cover the cross-feature release paths:

```bash
pnpm --filter @resolve/orchestrator exec vitest run src/routes/operations-expansion.integration.test.ts
pnpm --filter @resolve/orchestrator exec vitest run src/index.test.ts
pnpm --filter @resolve/zendesk-app exec vitest run api/worker-client.test.ts
pnpm --filter @resolve/zendesk-app exec vitest run features/chat/operations-expansion.integration.test.ts
```

They verify:

- phone lookup feeds a follow-up ShipStation order lookup and preserves bounded-scan `incomplete` status;
- phone-cache D1 rows expose only a versioned AES-GCM envelope; round-trip, ciphertext tampering, wrong-key rotation, and raw PII-at-rest checks run against native test D1;
- delegated voicemail metadata becomes an opaque transcript handle, existing Zendesk text remains usable when Workers AI is unavailable, and the transcript can produce a field proposal;
- the production Worker `fetch` route runs the registered `knowledge_search` handler against fake AI/Vectorize and real test D1, persists its filename/heading citation, and returns that citation from the history route;
- the default Worker `queue` entrypoint takes a staged R2/D1 candidate through the production repository to an indexed active version;
- an older queued knowledge candidate cannot activate after `pending_version_id` advances to a newer candidate;
- release configuration pins the Queue consumer to `max_batch_size: 1` and `max_concurrency: 2`;
- the shared `CitationSchema` lets `WorkerClient` parse persisted knowledge citations;
- a write remains inert until dedicated confirmation, then executes once, refetches, and returns verified state;
- stale and expired proposals do not execute;
- a Zendesk bearer token cannot authorize an admin upload; and
- migrations load as `0003_operations_expansion`, `0004_write_proposals`, then `0005_knowledge`.

## Worker checks

```bash
pnpm --filter @resolve/orchestrator test
pnpm --filter @resolve/orchestrator typecheck
pnpm --filter @resolve/orchestrator exec wrangler d1 migrations apply resolve --local
```

Set temporary environment values for a dry-run build:

```powershell
$env:BACKEND_AUTH_TOKEN = "ci-dry-run-token"
$env:TENANT_KEY = "ci-dry-run-tenant"
$env:WOO_SOLUTION_PEPTIDES_BASE_URL = "https://solutionpeptides.net"
$env:WOO_ATOMIK_LABZ_BASE_URL = "https://atomiklabz.com"
$env:CF_ACCESS_TEAM_DOMAIN = "resolve.cloudflareaccess.com"
$env:CF_ACCESS_AUD = "test-access-audience"
$env:PHONE_CACHE_HMAC_KEY = "test-phone-cache-hmac-key"
pnpm worker:dry-run
```

The dry run must list `DB`, `AI`, `KNOWLEDGE_BUCKET`, `KNOWLEDGE_INDEX`, `KNOWLEDGE_INDEX_QUEUE`, and `REQUEST_LIMITER` without deploying.

## 320px browser containment

Start the Zendesk Vite server and open the self-verifying fixture:

```bash
pnpm --filter @resolve/zendesk-app exec vite --host 127.0.0.1 --port 4173
```

```text
http://127.0.0.1:4173/features/chat/components/Conversation.browser.html
```

The Vite frame entry renders the production React `Conversation` and `ActionProposal` components. The knowledge case reaches the real `CitationLink` through `Conversation`/`MessageBubble`, and the frame imports the same font, token, and application CSS as the Zendesk entrypoint.

The named `long-url`, `transcript`, `proposal`, and `knowledge-citation` cases render inside a true 320px iframe. `data-status="pass"` requires the app root and document scroll widths to remain 320px and inspects `#root` plus every rendered descendant, not only message bubbles. The expected normal metrics are root width `320`, document scroll width `320`, no overflowing elements, and all four case names.

Use `?regression=1` to prove the detector fails. The intentional control applies a max-content regression to the actual long-URL `Conversation`; the detector must report `FAIL`, a document width greater than 320px, and named overflowing production descendants.

The harness source contract is also repeatable in Vitest:

```bash
pnpm --filter @resolve/zendesk-app exec vitest run features/chat/components/Conversation.browser.test.ts
```

## Zendesk package checks

```bash
pnpm --filter @resolve/zendesk-app test
pnpm --filter @resolve/zendesk-app build
pnpm zaf:validate
pnpm zaf:package
```

ZCLI validation and packaging are local and do not publish, but this ZCLI version requires Zendesk environment credentials or an interactive login. The ZCLI development server cannot substitute secure settings, so only an installed test app can prove the production proxy-injection path.

## Installed-app smoke test

Run in a Zendesk test account:

1. Install the generated ZIP and configure secure settings.
2. Confirm the active ticket and requester appear.
3. Open Settings and verify the active Słones model and effort match the Zendesk installation settings.
4. Ask for a WooCommerce order on a Solution Peptides ticket and verify its citation.
5. Ask for a WooCommerce order on an Atomik Labz ticket and verify the other store is never queried.
6. Ask for ShipStation tracking and verify carrier, service, and status.
7. Test v2 and legacy v1 separately when both are configured.
8. Ask how a prior requester ticket was resolved and verify ZAF performs the delegated search.
9. Search by a synthetic phone number and verify customer/order linkage plus completeness status.
10. Retrieve and transcribe a synthetic voicemail without exposing its recording URL to the model.
11. Search an indexed synthetic workflow and open its filename/heading citation.
12. Confirm an allowlisted synthetic update and verify the refetched record; repeat with stale and expired proposals.
13. Verify the admin URL accepts an authorized Access session and rejects the Zendesk backend token.
14. Reload the ticket and verify saved messages.
15. Open the same ticket as another authorized agent and verify team visibility.
16. Verify an ambiguous search asks for a selection rather than choosing silently.
17. Verify one unavailable provider produces a partial, clearly labeled result.
18. Verify malformed model or effort settings produce a safe configuration error.
19. Verify Worker logs contain no credentials, prompts, customer messages, raw audio, or plaintext phone cache keys.

Record only pass/fail, correlation IDs, and synthetic record IDs. Do not paste credentials or customer data into test notes.

## Retention check

Use local D1 to insert an expired synthetic conversation, trigger the scheduled handler, and verify its messages, tool runs, and pending turns are removed. Confirm non-expired conversations remain.
