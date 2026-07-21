# Resolve Operations Expansion Design

Date: 2026-07-20  
Status: Approved design  
Target: One unified Resolve release

## Summary

This release expands Słones from read-only order and ticket research into a broader customer-service assistant. It adds ShipStation phone lookup, Zendesk voicemail transcription, confirmed custom-field and customer-profile updates, and an administrator-managed Markdown workflow knowledge base. It also guarantees that assistant text remains contained inside the Zendesk sidebar.

The release ships as one version, but implementation and verification remain separated by subsystem so each boundary can be reviewed independently.

## Goals

1. Find ShipStation customers and related orders from a caller's phone number.
2. Retrieve Zendesk voicemail recordings and transcribe them with Cloudflare Workers AI.
3. Suggest and, after explicit confirmation, apply Zendesk ticket custom-field values.
4. Suggest and, after explicit confirmation, update allowed Zendesk customer-profile fields.
5. Let administrators upload, replace, list, and delete Markdown workflow documents.
6. Retrieve relevant knowledge chunks with citations during Słones conversations.
7. Keep all message text, links, and unbroken identifiers inside the visible chat bubble.
8. Preserve the existing two-brand WooCommerce separation, secret handling, permissions, and write-safety rules.

## Non-goals

- Calling undocumented ShipStation UI endpoints.
- Claiming a complete phone search when the public API scan reaches its bound.
- Persisting raw voicemail audio.
- Automatically applying Zendesk writes without a dedicated confirmation click.
- Modifying Zendesk email identities, passwords, roles, or merged profiles in this release.
- Letting uploaded Markdown override system safety, permission checks, tool schemas, or confirmation policy.
- Allowing non-administrators to manage knowledge files.

## Delivery structure

The feature is one release with five internal gates:

1. Phone lookup and bubble containment.
2. Voicemail retrieval and transcription.
3. Confirmed Zendesk mutations.
4. Knowledge-base ingestion and retrieval.
5. Integrated browser, Worker, package, and release verification.

No gate is considered complete until its focused tests, package tests, lint, and type checks pass.

## ShipStation phone lookup

### Public API limitation

ShipStation's user interface has a global phone search, but the public V1 and V2 APIs do not expose phone as a query parameter. V1 customer records and V2 shipment recipients include phone values, so Resolve will perform a bounded paginated scan and filter locally.

### Tool

Add `shipstation_find_customer_by_phone` with:

- `phone`: 7-20 characters before normalization.
- Optional `countryCode`.
- No free-form provider URL or credentials.

The tool returns:

- Normalized matching customers.
- Related normalized orders or shipments available from the scanned records.
- Source citations.
- `searchedRecords`.
- `incomplete`.
- The API generation used.

### Matching

- Strip punctuation, spaces, and extension markers.
- Preserve an optional leading country code.
- Compare full canonical digits first.
- If both values have at least ten digits, allow a last-ten-digit match.
- Never match fewer than seven digits.
- Deduplicate by provider customer or shipment ID.

### Search strategy

1. Prefer ShipStation V1 when a V1 key and secret are configured.
2. Request `/customers` with `pageSize=500`.
3. Scan no more than ten pages or 5,000 customers.
4. Stop early after enough exact matches are found.
5. If V1 is unavailable, scan at most five V2 shipment pages.
6. Return `incomplete: true` when more pages remain.

Successful phone-to-record mappings may be cached in D1 for 24 hours. Cache keys are a keyed hash of the normalized number, not the plaintext phone number. Cache misses never prove that the customer does not exist when a scan is incomplete.

## Voicemail transcription

### Zendesk retrieval

Extend the delegated Zendesk skill with `zendesk_list_voicemails`.

It calls:

`GET /api/v2/tickets/{ticket_id}/comments.json`

It returns voice comments containing:

- Comment ID.
- Created time.
- Caller/from metadata when available.
- `recording_url`.
- Existing Zendesk transcription text.
- A Zendesk ticket citation.

### Audio fetch policy

Add `zendesk_transcribe_voicemail`.

- Accept HTTPS recording URLs only.
- Never forward Zendesk authorization headers to the recording host.
- Reject localhost, loopback, link-local, private-IP literals, and non-HTTPS redirects.
- Allow at most three redirects.
- Require an audio MIME type or an MP3/WAV file extension.
- Limit downloads to 25 MB.
- Abort after 45 seconds.
- Do not persist raw bytes.

### Transcription

Bind Workers AI as `AI` and use:

`@cf/openai/whisper-large-v3-turbo`

The tool returns:

- Transcript text.
- Detected language when supplied.
- Duration or segment metadata when supplied.
- Recording comment/ticket citation.
- A source indicator: `zendesk_existing` or `cloudflare_whisper`.

If Zendesk already has non-empty transcription text, use it without paying for a second transcription unless the agent explicitly requests re-transcription.

## Confirmed Zendesk writes

### Supported writes

Add two delegated write actions:

1. `zendesk_update_ticket_custom_fields`
2. `zendesk_update_customer_profile`

Allowed profile fields:

- `name`
- `phone`
- `notes`
- `organization_id`
- Explicitly configured user custom fields

Disallowed profile fields:

- Email identities
- Role
- Password
- Suspension state
- External authentication identities
- Profile merge

### Custom-field discovery

Retrieve ticket-field definitions through Zendesk and expose:

- Field ID.
- Title.
- Type.
- Allowed options.
- Active state.

Słones may propose only active fields and valid option values.

### Confirmation state machine

1. Model emits a typed write proposal.
2. Resolve validates the target, field allowlist, and proposed values.
3. Resolve generates a cryptographically random single-use confirmation capability, persists only its hash, and returns the plaintext capability only to the proposing client.
4. Frontend retrieves the current record.
5. UI displays exact before/after values and target identifiers.
6. Agent clicks a dedicated Confirm button, sending the proposal ID and capability.
7. Resolve constant-time verifies and consumes the capability.
8. Resolve executes the delegated ZAF request once.
9. Frontend refetches the record.
10. Resolve reports the verified resulting state.

Free-form text such as "yes" is not confirmation. Proposals expire after ten minutes and become invalid if the current record changes. Caller-supplied agent IDs are informational audit metadata, not authoritative ownership; the unguessable capability protects confirmation while Zendesk enforces the actual confirming agent's permissions.

## Markdown knowledge base

### Administrator boundary

Knowledge management is a separate Worker-hosted admin portal protected by Cloudflare Access. It is not exposed as a normal agent action inside the Zendesk ticket sidebar.

Required Worker configuration:

- `CF_ACCESS_TEAM_DOMAIN`
- `CF_ACCESS_AUD`

Admin routes verify `Cf-Access-Jwt-Assertion`. Zendesk agent bearer authentication cannot access admin upload routes.

### Storage

- R2 bucket `resolve-knowledge` stores original Markdown files.
- D1 stores document and chunk metadata.
- Vectorize index `resolve-knowledge` stores semantic vectors.
- Workers AI binding `AI` generates embeddings.

### Upload policy

- `.md` files only.
- UTF-8 text only.
- Maximum 5 MB per file.
- Maximum 50 files per admin selection. To stay within Cloudflare request-body and isolate-memory limits, the portal sends one file per HTTP request with bounded concurrency.
- Stable document ID based on file identity, not filename alone.
- Re-upload replaces the prior version and vectors atomically.
- Each accepted file is staged in R2 and queued for one-document indexing in a separate Worker invocation.
- Delete retains a durable tombstone and asset inventory until R2 and Vectorize cleanup succeeds, then removes D1 metadata.

### Chunking and embeddings

- Parse YAML front matter when present.
- Split primarily by Markdown headings.
- Target approximately 800 tokens per chunk with 100-token overlap.
- Preserve filename, heading path, and chunk ordinal.
- Use `@cf/qwen/qwen3-embedding-0.6b`.
- Configure Vectorize for 1,024 dimensions and cosine distance.

### Retrieval

Add read-only `knowledge_search`.

- Embed the query.
- Fetch the top ten vectors.
- Apply metadata filters for brand or workflow category when available.
- Return the top five relevant chunks.
- Include filename and heading citations.

Knowledge is wrapped as untrusted `knowledge_context`. It can guide workflow choices but cannot alter system instructions, tool risk, permissions, or write confirmation.

## Admin portal

The portal provides:

- Multi-file drag-and-drop.
- Upload progress.
- File list.
- Indexing status.
- Chunk count.
- Last-updated timestamp.
- Replace action.
- Delete confirmation.
- Failed-file error details without exposing secrets.

The portal uses the same JetBrains Mono visual system but is deployed from the Worker, not packaged inside the Zendesk app ZIP.

## Message containment

Apply these rules to assistant content containers and descendants:

- `min-width: 0`
- `max-width: 100%`
- `overflow-wrap: anywhere`
- `word-break: break-word`
- Links constrained to the bubble width
- Inline code wraps safely
- Code blocks and tables scroll horizontally inside the bubble
- Images and media use `max-width: 100%`

No message content may create horizontal overflow on a 320px-wide app panel.

## Data model

Add D1 tables:

### `shipstation_phone_cache`

- `phone_hash`
- `result_json`
- `incomplete`
- `expires_at`

### `knowledge_documents`

- `id`
- `filename`
- `r2_key`
- `content_sha256`
- `status`
- `chunk_count`
- `created_at`
- `updated_at`

### `knowledge_chunks`

- `id`
- `document_id`
- `heading_path`
- `ordinal`
- `content`
- `vector_id`

### `write_proposals`

- `id`
- `conversation_id`
- `agent_id`
- `capability_hash`
- `action`
- `target_id`
- `before_json`
- `changes_json`
- `record_version`
- `expires_at`
- `status`

Do not store raw audio or plaintext phone-cache keys.

## Cloudflare bindings

Add:

- Workers AI binding: `AI`
- R2 binding: `KNOWLEDGE_BUCKET`
- Vectorize binding: `KNOWLEDGE_INDEX`

Keep:

- D1 binding: `DB`
- Request rate limiter
- Existing secrets

Admin upload and embedding operations use bounded concurrency. Async indexing may use `ctx.waitUntil`, but the portal must expose durable status rather than claiming indexing completed immediately.

## Error handling

- Phone lookup: return partial results plus `incomplete`.
- Audio: identify missing, expired, inaccessible, oversized, or unsupported recording separately.
- Transcription: retain existing Zendesk text if Workers AI fails.
- Writes: distinguish validation, permission, stale proposal, execution, and verification failures.
- Knowledge: preserve previously indexed version if replacement indexing fails.
- Chat: preserve the timeline and keep all errors inside message bounds.

## Testing

### Phone

- Punctuation and country-code normalization.
- Last-ten-digit matching.
- No short-number matching.
- V1 pagination and cap.
- V2 fallback and incomplete status.
- No plaintext phone cache keys.

### Audio

- Voice-comment parsing.
- Existing transcription reuse.
- Redirect, MIME, size, and timeout enforcement.
- No credential forwarding.
- Workers AI response normalization.
- No raw-audio persistence.

### Writes

- Field allowlist and option validation.
- Proposal expiration.
- Before/after rendering.
- No execution before button confirmation.
- Stale record rejection.
- Refetch verification.

### Knowledge

- Markdown and front-matter parsing.
- Chunk boundaries and overlap.
- R2/D1/Vectorize consistency.
- Replace rollback.
- Delete cleanup.
- Access JWT rejection.
- Retrieval citations.
- Safety precedence.

### UI

- 320px bubble containment.
- Long URL, phone, order ID, code, and table cases.
- Voicemail transcript rendering.
- Write confirmation keyboard and screen-reader behavior.
- Admin portal upload flow.

## Acceptance criteria

1. A phone number can retrieve matching ShipStation customers or shipments with explicit completeness status.
2. Słones no longer claims phone lookup is unsupported.
3. A ticket voicemail can be listed and transcribed without exposing Zendesk credentials.
4. Raw audio is not persisted.
5. Custom fields and allowed profile fields can be proposed, confirmed, executed, and verified.
6. No write executes without a dedicated confirmation click.
7. Administrators can manage multiple Markdown files through a Cloudflare Access-protected portal.
8. Słones cites knowledge filenames/headings in answers.
9. Knowledge cannot override safety or write policy.
10. All assistant content remains contained at 320px width.
11. Existing two-brand, order, shipment, ticket-history, persistence, and settings behavior remains green.
