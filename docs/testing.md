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
pnpm worker:dry-run
```

## Zendesk package checks

```bash
pnpm --filter @resolve/zendesk-app test
pnpm --filter @resolve/zendesk-app build
pnpm zaf:validate
pnpm zaf:package
```

ZCLI validation and packaging require Zendesk authentication. The ZCLI development server cannot substitute secure settings, so it cannot prove the production secret path.

## Installed-app smoke test

Run in a Zendesk test account:

1. Install the generated ZIP and configure secure settings.
2. Confirm the active ticket and requester appear.
3. Ask for a WooCommerce order and verify its citation.
4. Ask for ShipStation tracking and verify carrier, service, and status.
5. Test v2 and legacy v1 separately when both are configured.
6. Ask how a prior requester ticket was resolved and verify ZAF performs the delegated search.
7. Reload the ticket and verify saved messages.
8. Open the same ticket as another authorized agent and verify team visibility.
9. Verify an ambiguous search asks for a selection rather than choosing silently.
10. Verify one unavailable provider produces a partial, clearly labeled result.
11. Verify malformed settings produce a safe configuration error.
12. Verify Worker logs contain no credentials, prompts, or customer messages.

Record only pass/fail, correlation IDs, and synthetic record IDs. Do not paste credentials or customer data into test notes.

## Retention check

Use local D1 to insert an expired synthetic conversation, trigger the scheduled handler, and verify its messages, tool runs, and pending turns are removed. Confirm non-expired conversations remain.
