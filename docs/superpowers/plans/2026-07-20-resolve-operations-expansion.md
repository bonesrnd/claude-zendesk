# Resolve Operations Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one Resolve release that adds ShipStation phone lookup, Cloudflare voicemail transcription, confirmed Zendesk field/profile writes, a Cloudflare Access-protected Markdown knowledge base, and guaranteed chat-bubble containment.

**Architecture:** Extend the existing typed skill registry and Worker tool loop. Phone lookup remains a bounded ShipStation adapter operation; voicemail uses a Workers AI binding; writes use expiring proposals and delegated ZAF execution; knowledge uses R2, D1, Vectorize, Workers AI embeddings, and a separate Access-protected admin portal. The Zendesk app remains the agent surface and never receives infrastructure credentials.

**Tech Stack:** Existing TypeScript/pnpm/React/ZAF/Cloudflare stack plus Workers AI, R2, Vectorize, Cloudflare Access JWT verification, `workers-ai-provider`, Vercel AI SDK transcription helpers, and a Markdown parser.

## Global constraints

- Deliver all subsystems in one version, but complete gates in the listed order.
- Never call undocumented ShipStation UI endpoints.
- Never describe a capped phone scan as complete.
- Never forward Zendesk credentials to `recording_url`.
- Never persist raw voicemail audio.
- Never execute a write without a dedicated confirmation button.
- Restrict profile writes to the approved allowlist.
- Protect knowledge administration with Cloudflare Access, not agent-side role claims.
- Treat knowledge chunks as untrusted context below system safety and tool policy.
- Preserve two-brand WooCommerce credential isolation.
- Preserve current secure-setting behavior and Worker bearer authentication.
- Keep every assistant bubble contained at 320px.
- Do not create Cloudflare resources, commit, push, deploy, or publish a release without explicit user authorization for those actions.

---

### Task 1: Add phone lookup and message containment

**Files:**

- Modify: `packages/contracts/src/domain.ts`
- Modify: `packages/skills/src/shipstation/schemas.ts`
- Modify: `packages/skills/src/shipstation/client.ts`
- Modify: `packages/skills/src/shipstation/normalize.ts`
- Modify: `packages/skills/src/shipstation/shipstation.skill.ts`
- Create: `packages/skills/src/shipstation/phone.ts`
- Test: `packages/skills/src/shipstation/phone.test.ts`
- Test: `packages/skills/src/shipstation/client.test.ts`
- Test: `packages/skills/src/shipstation/shipstation.skill.test.ts`
- Create: `workers/orchestrator/migrations/0003_operations_expansion.sql`
- Create: `workers/orchestrator/src/repositories/phone-cache.ts`
- Test: `workers/orchestrator/src/repositories/phone-cache.test.ts`
- Modify: `apps/zendesk/src/styles/app.css`
- Test: `apps/zendesk/src/features/chat/components/Conversation.test.tsx`

**Interfaces:**

- Produces:
  - `normalizePhone(value: string, countryCode?: string): NormalizedPhone`
  - `ShipStationClient.findCustomerByPhone(input): Promise<PhoneSearchResult>`
  - Tool `shipstation_find_customer_by_phone`
  - `PhoneCacheRepository`
- Consumes: current ShipStation credentials and normalized domain schemas.

- [ ] **Step 1: Write failing phone-normalization tests**

```typescript
expect(normalizePhone("+1 (512) 555-0199 ext 4")).toEqual({
  digits: "15125550199",
  nationalDigits: "5125550199",
});

expect(phonesMatch("15125550199", "(512) 555-0199")).toBe(true);
expect(phonesMatch("5550199", "5125550199")).toBe(false);
```

Run:

```bash
pnpm --filter @resolve/skills exec vitest run src/shipstation/phone.test.ts
```

Expected: FAIL because phone helpers do not exist.

- [ ] **Step 2: Implement canonical phone matching**

Use digits only, strip common extension suffixes, require at least seven digits, compare exact values first, and allow last-ten comparison only when both values contain at least ten digits.

- [ ] **Step 3: Add V1 customer schemas and bounded pagination tests**

Add V1 `/customers` response schemas and tests for:

- `pageSize=500`
- ten-page maximum
- early exact match
- `incomplete: true` when `page < pages` after page ten
- no V1 credentials causes V2 fallback

The result contract is:

```typescript
interface PhoneSearchResult {
  customers: NormalizedCustomer[];
  orders: NormalizedOrder[];
  citations: Citation[];
  searchedRecords: number;
  incomplete: boolean;
  apiVersion: "v1" | "v2";
}
```

- [ ] **Step 4: Implement phone lookup tools**

Register:

```typescript
defineTool({
  name: "shipstation_find_customer_by_phone",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: z.strictObject({
    phone: z.string().min(7).max(40),
    countryCode: z.string().max(4).optional(),
  }),
  outputSchema: PhoneSearchOutputSchema,
  handler: findCustomerByPhone,
});
```

Update ShipStation instructions so Słones knows phone lookup exists and must mention incomplete scans.

- [ ] **Step 5: Add hashed D1 phone cache**

Migration:

```sql
CREATE TABLE shipstation_phone_cache (
  phone_hash TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  incomplete INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX shipstation_phone_cache_expiry_idx
  ON shipstation_phone_cache (expires_at);
```

Hash normalized phone values with an HMAC key supplied as a Worker secret. Never store plaintext phone numbers.

- [ ] **Step 6: Add bubble-containment regression tests**

Render assistant messages containing:

- a 300-character unbroken ID;
- a long URL;
- inline code;
- a code block;
- table-like content.

Assert the bubble and all text descendants have no document-level horizontal overflow at 320px.

- [ ] **Step 7: Implement containment CSS**

At minimum:

```css
.message,
.message-bubble {
  min-width: 0;
  max-width: 100%;
}

.message-bubble,
.message-bubble * {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.message-bubble pre,
.message-bubble table {
  max-width: 100%;
  overflow-x: auto;
}
```

- [ ] **Step 8: Verify gate**

```bash
pnpm --filter @resolve/skills test
pnpm --filter @resolve/orchestrator test
pnpm --filter @resolve/zendesk-app test
pnpm typecheck
```

Expected: PASS.

---

### Task 2: Add voicemail retrieval and Cloudflare transcription

**Files:**

- Modify: `workers/orchestrator/wrangler.jsonc`
- Regenerate: `workers/orchestrator/worker-configuration.d.ts`
- Modify: `workers/orchestrator/package.json`
- Modify: `packages/contracts/src/zendesk.ts`
- Modify: `packages/skills/src/zendesk/zendesk.skill.ts`
- Create: `packages/skills/src/zendesk/voicemail.ts`
- Test: `packages/skills/src/zendesk/voicemail.test.ts`
- Modify: `apps/zendesk/src/features/zendesk-tools/executor.ts`
- Test: `apps/zendesk/src/features/zendesk-tools/executor.test.ts`
- Create: `workers/orchestrator/src/services/audio-fetch.ts`
- Create: `workers/orchestrator/src/services/transcription.ts`
- Test: `workers/orchestrator/src/services/audio-fetch.test.ts`
- Test: `workers/orchestrator/src/services/transcription.test.ts`
- Modify: `workers/orchestrator/src/orchestration/run-turn.ts`

**Interfaces:**

- Produces:
  - Delegated tool `zendesk_list_voicemails`
  - Server tool `zendesk_transcribe_voicemail`
  - `fetchBoundedAudio(url, signal)`
  - `transcribeAudio(bytes, mediaType, env.AI)`
- Consumes: ZAF ticket comments and Workers AI binding.

- [ ] **Step 1: Write failing voice-comment parsing tests**

Use synthetic Zendesk comments with:

```json
{
  "id": 99,
  "type": "VoiceComment",
  "recording_url": "https://recordings.example/99.mp3",
  "transcription_text": "",
  "created_at": "2026-07-20T12:00:00Z"
}
```

Assert only valid HTTPS voice comments are returned.

- [ ] **Step 2: Implement delegated voicemail listing**

Extend the existing comments request and return typed voice-comment metadata with ticket citations.

- [ ] **Step 3: Write audio-fetch security tests**

Cover:

- HTTP rejected;
- loopback/private/link-local literal rejected;
- more than three redirects rejected;
- 25 MB cap;
- non-audio MIME rejected;
- no authorization header forwarded;
- timeout abort.

- [ ] **Step 4: Add Workers AI transcription binding**

`wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI" }
```

Install current packages:

```bash
pnpm add --filter @resolve/orchestrator ai workers-ai-provider
```

Use:

```typescript
const transcript = await experimental_transcribe({
  model: workersai.transcription("@cf/openai/whisper-large-v3-turbo"),
  audio,
  mediaType,
});
```

- [ ] **Step 5: Reuse existing Zendesk transcription**

If `transcription_text.trim()` is non-empty, return it with source `zendesk_existing` without fetching audio.

- [ ] **Step 6: Implement and register transcription tool**

Return text, language/segments when available, source, and citations. Do not return or persist audio bytes.

- [ ] **Step 7: Verify gate**

```bash
pnpm --filter @resolve/skills test
pnpm --filter @resolve/orchestrator exec wrangler types
pnpm --filter @resolve/orchestrator test
pnpm typecheck
pnpm worker:dry-run
```

Expected: PASS.

---

### Task 3: Add confirmed Zendesk custom-field and profile writes

**Files:**

- Modify: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/actions.ts`
- Modify: `packages/skill-sdk/src/types.ts`
- Modify: `workers/orchestrator/src/orchestration/run-turn.ts`
- Create: `workers/orchestrator/src/repositories/write-proposals.ts`
- Test: `workers/orchestrator/src/repositories/write-proposals.test.ts`
- Create: `workers/orchestrator/src/routes/actions.ts`
- Test: `workers/orchestrator/src/routes/actions.test.ts`
- Modify: `workers/orchestrator/src/http/router.ts`
- Modify: `packages/skills/src/zendesk/zendesk.skill.ts`
- Modify: `apps/zendesk/src/api/worker-client.ts`
- Modify: `apps/zendesk/src/features/chat/chat-controller.ts`
- Create: `apps/zendesk/src/features/actions/ActionProposal.tsx`
- Test: `apps/zendesk/src/features/actions/ActionProposal.test.tsx`
- Modify: `apps/zendesk/src/features/zendesk-tools/executor.ts`
- Test: `apps/zendesk/src/features/zendesk-tools/executor.test.ts`

**Interfaces:**

- Produces:
  - `action_confirmation_required` Worker response
  - `WriteProposal`
  - `POST /v1/actions/:id/confirm`
  - Delegated writes for custom fields and profile updates
- Consumes: current conversation context, a single-use confirmation capability, and ZAF permissions. Caller-supplied agent IDs are audit metadata only.

- [ ] **Step 1: Define proposal contracts**

```typescript
interface WriteProposal {
  id: string;
  action:
    "zendesk_update_ticket_custom_fields" | "zendesk_update_customer_profile";
  targetId: number;
  before: Record<string, unknown>;
  changes: Record<string, unknown>;
  expiresAt: string;
}
```

Add `action_confirmation_required` to `TurnResponseSchema`.

- [ ] **Step 2: Make the dispatcher refuse direct write execution**

Test that any `risk: "write"` tool returns a proposal and never calls its handler or delegated executor before confirmation.

- [ ] **Step 3: Add proposal persistence**

Migration:

```sql
CREATE TABLE write_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_id INTEGER NOT NULL,
  capability_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  record_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);
```

- [ ] **Step 4: Add field-definition and current-record reads**

Frontend obtains active ticket fields, user profile, and ticket-field definitions before rendering a proposal. Reject inactive fields and invalid option values.

- [ ] **Step 5: Add confirmation UI tests**

Assert:

- exact before/after values shown;
- confirm and cancel are distinct;
- Enter in chat cannot confirm;
- expired proposal cannot confirm;
- keyboard focus is trapped correctly in the proposal;
- screen reader announces target and changes.

- [ ] **Step 6: Implement confirmed execution**

The confirmation endpoint requires the proposal ID plus the plaintext single-use capability returned only to the proposing client. It constant-time verifies the persisted capability hash, validates state/expiry, consumes the capability, and returns a delegated write request. The frontend executes through ZAF, returns the result, and refetches the record.

- [ ] **Step 7: Add stale-record verification**

Compare the current version/update timestamp with `record_version` immediately before execution. Reject stale proposals.

- [ ] **Step 8: Verify gate**

```bash
pnpm --filter @resolve/contracts test
pnpm --filter @resolve/skill-sdk test
pnpm --filter @resolve/orchestrator test
pnpm --filter @resolve/zendesk-app test
pnpm typecheck
```

Expected: no write occurs without confirmation; all checks PASS.

---

### Task 4: Add the Access-protected Markdown knowledge base

**Files:**

- Modify: `workers/orchestrator/wrangler.jsonc`
- Regenerate: `workers/orchestrator/worker-configuration.d.ts`
- Create: `workers/orchestrator/migrations/0005_knowledge.sql`
- Create: `workers/orchestrator/src/admin/access.ts`
- Test: `workers/orchestrator/src/admin/access.test.ts`
- Create: `workers/orchestrator/src/admin/knowledge-html.ts`
- Create: `workers/orchestrator/src/routes/knowledge-admin.ts`
- Test: `workers/orchestrator/src/routes/knowledge-admin.test.ts`
- Create: `workers/orchestrator/src/repositories/knowledge.ts`
- Test: `workers/orchestrator/src/repositories/knowledge.test.ts`
- Create: `workers/orchestrator/src/knowledge/markdown.ts`
- Create: `workers/orchestrator/src/knowledge/chunk.ts`
- Create: `workers/orchestrator/src/knowledge/embed.ts`
- Create: `workers/orchestrator/src/knowledge/search.ts`
- Test: `workers/orchestrator/src/knowledge/markdown.test.ts`
- Test: `workers/orchestrator/src/knowledge/search.test.ts`
- Create: `packages/skills/src/knowledge/knowledge.skill.ts`
- Test: `packages/skills/src/knowledge/knowledge.skill.test.ts`
- Modify: `packages/skills/src/registry.ts`

**Interfaces:**

- Produces:
  - Admin portal `/admin/knowledge`
  - Admin API `/admin/api/knowledge`
  - Tool `knowledge_search`
  - Queue-backed R2/D1/Vectorize ingestion pipeline
- Consumes: Cloudflare Access assertion, Workers AI embeddings, and the knowledge-indexing Queue.

- [ ] **Step 1: Add Cloudflare resource bindings**

`wrangler.jsonc`:

```jsonc
"r2_buckets": [
  { "binding": "KNOWLEDGE_BUCKET", "bucket_name": "resolve-knowledge" }
],
"vectorize": [
  { "binding": "KNOWLEDGE_INDEX", "index_name": "resolve-knowledge" }
],
"queues": {
  "producers": [
    { "binding": "KNOWLEDGE_QUEUE", "queue": "resolve-knowledge-index" }
  ],
  "consumers": [
    { "queue": "resolve-knowledge-index", "max_batch_size": 1 }
  ]
}
```

Declare required secrets:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`
- `PHONE_CACHE_HMAC_KEY`

- [ ] **Step 2: Write Access JWT rejection tests**

Test missing, expired, wrong-audience, wrong-issuer, and invalid-signature assertions. Fetch keys only from the configured Access team domain and cache them safely.

- [ ] **Step 3: Add knowledge migrations**

Create document and chunk tables from the approved design with foreign keys and indexing-state constraints.

- [ ] **Step 4: Write Markdown chunking tests**

Use headings, front matter, code fences, lists, and long sections. Assert stable heading paths, ordinals, approximate size, and overlap.

- [ ] **Step 5: Implement staged, queued upload**

1. Allow up to 50 files per admin selection, but send exactly one file per bounded HTTP request.
2. Validate and hash the file.
3. Write a candidate R2 object and durable queued metadata.
4. Enqueue a small document/version message.
5. In a one-document Queue invocation, chunk and embed.
6. Upsert vectors and immutable candidate-version metadata.
7. Promote the candidate object.
8. Atomically CAS the active-version pointer.
9. Delete prior vectors/object only after success.

On failure, retain the prior indexed version. Deletion first writes a durable tombstone and keeps retry inventory until R2 and Vectorize cleanup succeeds.

- [ ] **Step 6: Implement admin portal**

Serve a CSP-protected HTML page with drag-and-drop, multi-file progress, status, replace, and delete confirmation. Do not embed infrastructure secrets.

- [ ] **Step 7: Implement semantic search**

Embed query with `@cf/qwen/qwen3-embedding-0.6b`, request top ten vectors, load chunks, filter/deduplicate, and return top five citations.

- [ ] **Step 8: Register `knowledge_search`**

The model-facing description states that knowledge may guide workflow but never override safety or permissions.

- [ ] **Step 9: Verify gate**

```bash
pnpm --filter @resolve/orchestrator test
pnpm --filter @resolve/skills test
pnpm typecheck
pnpm worker:types:check
pnpm worker:dry-run
```

Expected: PASS.

---

### Task 5: Integrate, deploy resources, and publish one release

**Files:**

- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `docs/skills.md`
- Modify: `docs/testing.md`
- Modify: `apps/zendesk/zendesk/manifest.json`
- Modify: `apps/zendesk/zendesk/translations/en.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: all four completed subsystem gates.
- Produces: one validated Worker deployment and one Zendesk release ZIP.

- [ ] **Step 1: Run integrated conversation tests**

Scenarios:

- phone → customer → order;
- voicemail → transcript → suggested fields;
- knowledge → cited workflow;
- proposal → confirm → refetch;
- partial ShipStation scan;
- failed transcription with existing Zendesk transcript;
- unauthorized admin upload.

- [ ] **Step 2: Run browser containment tests**

At 320px, verify no document-level horizontal overflow and capture screenshots of long URL, transcript, proposal, and knowledge citation messages.

- [ ] **Step 3: Provision Cloudflare resources**

After explicit approval:

```bash
wrangler r2 bucket create resolve-knowledge
wrangler vectorize create resolve-knowledge \
  --dimensions 1024 \
  --metric cosine
wrangler d1 migrations apply resolve --remote
```

Configure Cloudflare Access for `/admin/*` and set its team domain/audience secrets.

- [ ] **Step 4: Run final verification**

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
pnpm --filter @resolve/zendesk-app package:zip
```

Extract the ZIP, run Zendesk Apps Support validation, verify relative assets, and calculate SHA256.

- [ ] **Step 5: Deploy Worker**

After explicit approval, deploy and verify:

- unauthenticated `/health` returns 401;
- authenticated `/health` returns 200;
- admin route requires valid Access;
- D1, AI, R2, and Vectorize bindings are present.

- [ ] **Step 6: Installed-app smoke test**

Update a Zendesk test installation and verify all acceptance criteria with synthetic records before using customer data.

- [ ] **Step 7: Commit, push, and publish**

Only after explicit user authorization:

- commit with repository convention;
- push `main`;
- create one new GitHub release;
- attach only the ZCLI-Archiver Zendesk ZIP;
- include checksum and resource prerequisites.

## Final self-review

- Every approved requirement maps to a task and test.
- Phone search never claims unsupported; it reports completeness.
- No raw audio or plaintext phone cache keys are persisted.
- No write bypasses confirmation.
- Admin uploads require Cloudflare Access.
- Knowledge does not alter safety policy.
- Bubble containment is covered at 320px.
- Existing Resolve and Słones functionality remains green.
