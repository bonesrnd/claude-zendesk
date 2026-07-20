# Resolve: Zendesk Private App Design

Date: 2026-07-18  
Status: Approved design

## Summary

Resolve is a private Zendesk Support app that gives customer-service agents a ticket-aware Claude chat. It retrieves order, customer, shipment, tracking, and historical ticket information through typed skills, shows the sources used in each answer, and preserves ticket-scoped conversations for 90 days.

The first release is a working, read-only MVP. It proves the complete security and orchestration path before customer-profile merges, profile creation, tags, shipping-service changes, and other mutations are enabled. Every future write action will require a structured preview and an explicit agent confirmation.

## Product decisions

- Product name: Resolve.
- Assistant name: Słones. Resolve remains the Zendesk app and administrative package name.
- Interface: Quiet Console visual language in a wide Zendesk ticket side panel.
- Typography: JetBrains Mono throughout the assistant interface.
- LLM: Anthropic Claude behind a provider interface.
- Model policy: Zendesk administrators select a validated Claude model and effort level in installation settings; defaults are `claude-sonnet-5` and `medium`.
- Backend: Cloudflare Workers.
- Persistence: Cloudflare D1, shared by authorized agents viewing the same ticket.
- Retention: 90 days, enforced by a scheduled cleanup job.
- Deployment: one Zendesk account and one private app installation.
- Historical learning: live Zendesk retrieval with ticket citations, not fine-tuning or a copied vector index.
- WooCommerce: route Solution Peptides and Atomik Labz tickets to isolated store credentials based on the active Zendesk brand; never search both stores.
- ShipStation: support API v2 and legacy API v1 behind one normalized adapter.
- Secrets: entered as Zendesk secure installation settings and injected by Zendesk's proxy into allow-listed Worker requests.
- Response delivery: non-streaming for the MVP because secure requests pass through the Zendesk proxy. The API boundary will not preclude a later streaming bootstrap.

## Goals

1. Let an agent ask natural-language questions without leaving the active ticket.
2. Ground answers in the current ticket and retrieved provider records.
3. Retrieve WooCommerce orders, customers, prior orders, shipping details, and returned order metadata.
4. Retrieve ShipStation orders, shipments, recipient/customer details, tracking, carrier, and service information through either supported API generation.
5. Retrieve a requester's prior Zendesk tickets and search solved-ticket patterns under the current agent's Zendesk permissions.
6. Display tool activity, partial failures, and source links so agents can verify an answer.
7. Persist ticket-scoped chat history for team continuity without storing integration credentials or raw provider payloads.
8. Make skills easy to add, validate, configure, observe, and remove without coupling them to the chat UI.
9. Establish a safe path to future write tools.

## Non-goals for the MVP

- Performing Zendesk profile creation or merges.
- Mutating WooCommerce data.
- Adding or removing ShipStation tags.
- Changing ShipStation carrier, service, address, package, hold, or shipment fields.
- Purchasing or voiding shipping labels.
- Token-by-token response streaming.
- Indexing all Zendesk tickets outside Zendesk.
- Training or fine-tuning a model on customer data.
- Uploading or executing arbitrary skill code at runtime.
- Supporting multiple Zendesk tenants.

## Delivery milestones

### Milestone 1: read-only MVP

- Installable ZAF v2 private app.
- Quiet Console wide side-panel chat.
- Active ticket and requester context.
- Anthropic tool-use orchestration.
- WooCommerce read skill.
- ShipStation v1 and v2 read skill.
- Zendesk history and solved-ticket retrieval skill.
- Ticket-scoped D1 conversations.
- Skills status view and health checks.
- Secure installation settings.
- Test, build, package, and deployment documentation.

### Milestone 2: confirmed mutations

- Zendesk customer-profile creation.
- Zendesk profile merge with source/destination preview.
- ShipStation tag addition and removal.
- ShipStation shipping-service changes on editable records.
- Supported pre-shipment updates such as address, package, options, or hold state where the selected API permits them.
- A universal propose, confirm, execute, refetch, and report flow.
- Idempotency keys and durable audit events for every attempted write.

### Milestone 3: optional experience improvements

- Short-lived session bootstrap for direct Worker streaming.
- Additional skill packs.
- Admin-configurable skill enablement where Zendesk's installation-setting model permits it.
- Stronger server-verified per-agent authorization if future deployments need role-specific Worker permissions.

## System architecture

### Zendesk app

The frontend is a packaged ZAF v2 ticket-sidebar app. It:

- Initializes the ZAF client.
- Reads the active ticket, requester, current agent, conversation, and installation settings.
- Sends authenticated Worker requests through `client.request()` with `secure: true`.
- Executes delegated Zendesk tool calls through ZAF so Zendesk applies the current agent's session and permissions.
- Renders messages, tool states, citations, setup errors, and persistence warnings.
- Does not read secure installation settings or call Anthropic, WooCommerce, or ShipStation directly.

The manifest uses a flexible ticket-sidebar location so the side panel can occupy the selected wide layout.

### Zendesk proxy

Zendesk's proxy is the secret boundary between the iframe and Cloudflare. The app sends placeholders such as `{{setting.anthropic_api_key}}` only inside secure `client.request()` calls. Zendesk injects the actual values after the request leaves the browser.

Only the Worker hostname is added to `domainWhitelist`. Secure settings are scoped to request headers. Secure values never appear in frontend state, browser network payloads, D1, analytics, or logs.

### Cloudflare Worker

The Worker:

- Authenticates requests with an installation-specific backend token that is also stored as a Worker secret.
- Validates tenant, ticket, conversation, message, and tool payloads.
- Loads the enabled skill catalog.
- Calls the Anthropic Messages API with registered tool schemas.
- Executes WooCommerce and ShipStation tools.
- Returns delegated Zendesk tool requests to the frontend.
- Continues the Claude turn after receiving a delegated result.
- Stores conversations, messages, and compact tool summaries in D1.
- Enforces time, token, result-size, and tool-call limits.
- Returns typed errors rather than provider-specific response bodies.

The Worker never persists credentials. Credentials received in secure request headers exist only for the duration of the request.

Both WooCommerce origins are configured as required Worker deployment secrets. The Worker maps the active Zendesk ticket brand to Solution Peptides or Atomik Labz, selects only that store's credentials, and rejects unknown brands or origin mismatches before forwarding credentials.

### Delegated Zendesk tools

The Worker cannot use the agent's browser session. When Claude requests a Zendesk operation, the Worker returns a typed `delegated_tool_request`. The frontend validates the request against its own Zendesk tool registry, executes it with ZAF, compacts the result, and posts a `delegated_tool_result` back to the Worker.

This protocol allows historical ticket search to use the current agent's Zendesk permissions without giving the Worker a general Zendesk API token.

### External services

- Anthropic: Messages API and tool use.
- WooCommerce: REST API v3 over HTTPS with consumer key and secret.
- ShipStation v2: `api-key` header.
- ShipStation v1: Basic authentication using the legacy key and secret.
- Zendesk: ZAF and Zendesk Support APIs through the active agent session.

## Suggested repository boundaries

The implementation will use a TypeScript workspace with focused packages:

- `apps/zendesk`: React/ZAF app, ticket context, delegated Zendesk tools, and UI.
- `workers/orchestrator`: Worker routes, authentication, Claude loop, D1 access, retention, and server-side tool execution.
- `packages/contracts`: shared request, response, message, error, citation, and domain-record schemas.
- `packages/skill-sdk`: `defineSkill`, `defineTool`, risk policy, health-check, and validation primitives.
- `packages/skills`: WooCommerce, ShipStation, and Zendesk skill packs.
- `packages/test-support`: fixtures, provider mocks, and contract-test helpers.
- `scripts`: skill scaffolding, catalog generation, manifest-setting generation, and package validation.

The frontend does not import provider adapters. The orchestrator does not import UI code. Each skill pack depends only on the skill SDK, shared contracts, and the provider client it owns.

## Request and response flow

1. The agent submits a message.
2. The app gathers bounded ticket context: ticket ID, subject, requester identity, selected fields, and recent conversation entries.
3. The app posts the message and context through a secure Zendesk-proxy request.
4. The Worker authenticates and validates the request, loads the ticket conversation from D1, and calls Claude with only enabled tool definitions.
5. If Claude calls a WooCommerce or ShipStation tool, the Worker validates the input, executes the adapter, normalizes the result, records a compact tool event, and continues the model turn.
6. If Claude calls a Zendesk tool, the Worker stores the pending turn and returns a delegated tool request.
7. The app executes the Zendesk request through ZAF and returns a compact result.
8. The Worker resumes the model turn and returns either another tool request or the final answer.
9. The app renders the answer, tool activity, and citations.

The loop has a fixed tool-call count and wall-clock budget. A request that cannot finish within its budget returns a continuation state or a visible limit error; it does not loop indefinitely.

## Worker API shape

The exact URL structure may evolve without changing the contracts, but the MVP needs these capabilities:

- Start or continue a user turn.
- Submit a delegated Zendesk tool result.
- Create or load a ticket-scoped conversation.
- List messages for a ticket conversation.
- List registered skills and non-secret configuration status.
- Run provider health checks.

Every response is a discriminated union:

- `assistant_message`
- `delegated_tool_request`
- `continuation_required`
- `configuration_error`
- `integration_error`
- `validation_error`
- `orchestration_limit`

## Conversation persistence

### Stored data

- Conversation ID, tenant key, Zendesk ticket ID, created time, updated time, and expiry time.
- Message role, display content, timestamps, and non-sensitive token/usage metadata.
- Tool skill ID, tool name, state, compact request summary, compact result summary, citation metadata, timestamps, and safe error code.
- Informational agent ID and display name for continuity. In the MVP these are not treated as cryptographically verified audit identities.

### Excluded data

- Installation settings.
- Authorization headers.
- Anthropic, WooCommerce, or ShipStation credentials.
- Raw third-party API payloads.
- Full Zendesk account exports.
- Hidden model reasoning.

Any authorized agent using the installed app on the same ticket can load its conversation. A scheduled Worker job deletes expired conversations and dependent rows after 90 days.

## Interface design

### Visual direction

Quiet Console uses warm paper neutrals, dark ink, restrained green success states, orange action accents, and JetBrains Mono throughout. It is calm and operational rather than visually resembling a generic AI dashboard.

### Layout

- Wide, flexible Zendesk ticket side panel.
- Compact Resolve header with reset and overflow actions.
- Pinned customer and ticket context strip.
- Single-column message timeline.
- Tool activity stack between the triggering message and final answer.
- Inline, actionable errors.
- Source citations that open the relevant Zendesk ticket or provider record when a safe URL is available.
- Fixed composer with disabled, working, retry, and ready states.

### Behavior

- The initial state offers a few useful ticket-aware prompts without sending them automatically.
- Sending a message immediately adds it to the timeline and shows tool progress.
- Complete answers arrive as one message in the MVP.
- Ambiguous matches display a safe disambiguation choice instead of allowing the model to guess.
- Partial results preserve successful sources and label unavailable sources.
- Reset starts a new conversation for the ticket without deleting prior retained history.

## Skill system

### Skill pack contract

Every skill is a versioned, reviewed module created with `defineSkill`. A skill declares:

- Stable ID, name, description, and semantic version.
- Model instructions scoped to that skill.
- Tool definitions.
- Input and output schemas.
- Read or write risk classification per tool.
- Approval requirement.
- Required credential references and visible settings.
- Provider timeouts, retry policy, and result-size limits.
- Health-check behavior.
- Redaction rules.
- Contract fixtures.

Every tool is created with `defineTool` and supplies:

- A globally unique tool name.
- A concise model-facing description.
- An input schema that rejects unknown fields.
- A stable output schema.
- A handler or delegated-execution marker.
- A risk level.
- A citation mapper.
- Safe error mapping.

The dispatcher, not the model prompt, enforces risk and approval policy.

### Skill discovery and packaging

Skills are reviewed source code, not runtime uploads. A scaffold command creates a skill folder, manifest, tool files, fixtures, and tests. A build-time generator:

1. Discovers registered skill packs.
2. Validates unique IDs, tool names, schemas, risk levels, and credential references.
3. Generates a non-secret skill catalog for the UI.
4. Generates or verifies the related Zendesk installation-setting definitions.
5. Fails the build if a write tool lacks mandatory approval.

Because Zendesk installation parameters are fixed in the packaged manifest, adding a credentialed skill requires publishing a new private-app package. This limitation is explicit; the generator makes the package update mechanical.

### Skills manager

The UI exposes a skills manager that shows:

- Skill name and version.
- Available read and write capabilities.
- Enabled or unavailable state.
- Non-secret configuration status.
- Selected provider/API mode.
- Last health-check result.
- A link to the relevant Zendesk installation settings.

The manager never reads or echoes secure values. It does not install executable code.

## Initial skills

### Zendesk history

Read tools:

- Get the active ticket and requester context.
- Retrieve the requester's prior tickets.
- Search solved tickets using bounded keywords, status, date, brand, form, organization, or other supported filters.
- Fetch the small set of cited tickets needed to understand a past resolution.

Results include ticket IDs, subjects, status, timestamps, safe snippets, and URLs. The model must cite tickets used in an answer. This is retrieval, not durable learning.

### WooCommerce

Read tools:

- Find an order by order number or ID.
- Find a customer by email or customer ID.
- List a customer's prior orders.
- Retrieve the details of a selected order.

The ticket's Zendesk brand selects the store connection. Solution Peptides maps to `solutionpeptides.net`; Atomik Labz maps to `atomiklabz.com`. Each connection has an independent consumer key and secret. Unknown brands fail closed and never trigger a cross-store search.

Normalized output includes order status, dates, totals, currency, line items, billing/shipping summaries, shipping method, refunds where returned, and returned metadata. Arbitrary metadata is retrieved from selected records; the MVP does not promise server-side search by arbitrary metadata because the standard WooCommerce API does not provide that filter.

### ShipStation

Read tools:

- Find orders or shipments by supported order number, external ID, recipient, or date filters.
- Retrieve a selected order or shipment.
- Retrieve recipient/customer details available to the configured API.
- Retrieve tracking number, carrier, service, status, label state, and tracking events where supported.

The adapter chooses v2 or v1 from installation settings and maps both APIs to stable internal records. Provider-specific IDs are preserved for citations and future write targeting.

## Future write policy

Every write follows this state machine:

1. Claude proposes a typed action.
2. Resolve validates the target and current provider state.
3. The UI shows a structured preview with the exact record, before state, intended change, and risk.
4. The agent confirms with a dedicated button.
5. The dispatcher executes once using an idempotency key where the provider supports it.
6. Resolve refetches the target.
7. The UI reports the verified resulting state and records a safe audit event.

Free-form text such as "yes" is not sufficient confirmation. A stale preview expires and must be regenerated. Writes cannot be batched behind a single generic approval.

## Installation settings

Visible settings:

- Worker HTTPS URL.
- Zendesk account/subdomain identifier.
- Słones Claude model identifier.
- Słones effort: `low`, `medium`, `high`, `xhigh`, or `max`.
- Solution Peptides WooCommerce HTTPS origin.
- Atomik Labz WooCommerce HTTPS origin.
- ShipStation mode: v2, v1, or automatic preference.
- Optional skill enablement flags supported by the packaged manifest.

Secure header-only settings:

- Backend authentication token.
- Anthropic API key.
- Solution Peptides WooCommerce consumer key and secret.
- Atomik Labz WooCommerce consumer key and secret.
- ShipStation v2 API key.
- ShipStation v1 API key.
- ShipStation v1 API secret.

ShipStation credentials are optional as a group based on the selected mode. Both WooCommerce connections and Anthropic credentials are required for their skills to report fully ready; per-store health remains visible.

The app's health view tests configuration without returning secret values.

## Security and privacy

- Require HTTPS for Worker and WooCommerce origins.
- Resolve WooCommerce credentials only after validating the active ticket brand against the two explicit brand mappings.
- Pin secure setting use to the Worker domain through `domainWhitelist`.
- Compare the proxy-injected backend token with a Cloudflare Worker secret using a timing-safe comparison.
- Reject unrecognized tenant identifiers and unsafe provider origins.
- Validate every body, path, query, tool input, and provider result at trust boundaries.
- Apply per-installation rate limits and bounded concurrency.
- Redact authentication headers, secret setting names and values, and sensitive provider fields from logs.
- Store compact tool summaries rather than raw payloads.
- Do not send unrelated ticket history or full customer records to Claude.
- Treat retrieved ticket text and provider metadata as untrusted data, never as model instructions.
- Escape rendered content and disallow arbitrary HTML from model output.
- Require explicit confirmation for every future write.

The MVP's shared installation token authorizes use of the Worker by the single Zendesk installation. It does not provide strong per-agent server authorization. Zendesk delegated reads still use the current agent's real permissions. If later requirements need role-specific Worker permissions, add a server-verifiable Zendesk identity flow before exposing restricted server-side actions.

## Error handling

### Configuration errors

Name the affected skill, explain which non-secret setting category is missing or invalid, link to app settings, and never echo submitted credentials.

### Rate limits and transient failures

Honor `Retry-After`. Retry safe reads with exponential backoff and jitter within the request budget. After the budget is exhausted, preserve other successful results and provide a manual retry.

### Ambiguous matches

Return a typed choice list with only the fields needed to distinguish records. Do not let Claude select silently.

### Partial failures

The final answer may use successful sources but must state which source failed. Citations only reference results actually retrieved.

### Persistence failures

Keep the current in-memory UI state usable, show that history was not saved, and allow retry. Do not claim persistence succeeded.

### Orchestration failures

Stop on invalid tool input, repeated equivalent calls, call-count limit, token limit, or wall-clock limit. Return completed work and a safe explanation.

### Future write failures

Never retry a write unless its idempotency behavior is known. On uncertain outcomes, refetch before offering another attempt.

## Observability

Structured logs may contain:

- Request and correlation IDs.
- Tenant key hash.
- Skill and tool IDs.
- Durations, attempt counts, status codes, safe error codes, and model token usage.
- Conversation and tool-run IDs.

Logs must not contain secrets, raw authorization headers, raw provider bodies, full prompts, or full customer messages. Health endpoints report dependency status without secret details.

## Testing strategy

### Unit tests

- Schema validation.
- Provider normalizers.
- Retry and timeout logic.
- D1 repositories and retention.
- Prompt-data isolation.
- Citation mapping.
- Risk and approval policy.
- Error redaction.

### Skill contract tests

- Manifest and tool-name uniqueness.
- Input/output fixture validation.
- WooCommerce response fixtures.
- ShipStation v1 and v2 response fixtures.
- Provider error mapping.
- Result-size compaction.
- A build failure for any write tool without mandatory approval.

### Worker integration tests

- Authenticated and unauthenticated routes.
- D1 migrations and conversation lifecycle.
- Claude tool-loop behavior with a mocked model.
- Server-side tools with mocked providers.
- Delegated Zendesk tool pause/resume.
- Partial failures and orchestration limits.

### Frontend tests

- Ticket context collection.
- Conversation rendering.
- Tool progress and partial-error states.
- Citation behavior.
- Ambiguous-match selection.
- Persistence warnings.
- Skills-manager status.

### Installed-app smoke tests

Zendesk's local ZCLI server cannot substitute secure settings, so the real secure path is verified by packaging the app and installing it in a Zendesk test account. Smoke tests cover proxy injection, Worker authentication, ticket context, delegated Zendesk reads, and at least one provider health check.

### Continuous integration

CI runs formatting, linting, type checking, unit tests, skill contract tests, Worker integration tests, production builds, ZAF package validation, and migration checks.

## MVP acceptance criteria

1. An admin can package and install Resolve as a private ZAF app and enter all required visible and secure settings.
2. An agent can open a ticket and use the wide Quiet Console chat without leaving Zendesk.
3. Resolve automatically grounds the first turn in the active ticket and requester.
4. The agent can retrieve WooCommerce customer, order, prior-order, and returned metadata information from the active ticket brand's store without querying the other store.
5. The agent can retrieve ShipStation v1 or v2 order, shipment, recipient, carrier, service, and tracking information according to the configured API.
6. The agent can retrieve the requester's prior Zendesk tickets and search relevant solved tickets under their own permissions.
7. Answers visibly show tool activity and cite the source records used.
8. Ambiguous matches require agent selection; missing results are not invented.
9. A failure in one integration does not discard successful results from another.
10. Conversations can be reopened by another authorized agent viewing the same ticket.
11. Conversations expire and are deleted after 90 days.
12. D1 and logs contain no integration credentials or raw authorization headers.
13. The skills manager reports skill version, capabilities, configuration status, and health without exposing secrets.
14. A new reviewed skill can be scaffolded, contract-tested, registered, and packaged without modifying the chat UI or core Claude loop.
15. All automated checks pass, and the packaged app validates before test-account installation.

## References

- [Zendesk: Making API requests from an app](https://developer.zendesk.com/documentation/apps/app-developer-guide/making-api-requests-from-a-zendesk-app/)
- [Zendesk: Manifest reference](https://developer.zendesk.com/documentation/apps/app-developer-guide/manifest/)
- [Zendesk: ZAF Client API](https://developer.zendesk.com/api-reference/apps/apps-core-api/client_api/)
- [WooCommerce REST API](https://developer.woocommerce.com/docs/apis/rest-api/)
- [WooCommerce REST API v3 orders](https://developer.woocommerce.com/docs/apis/rest-api/v3/orders/)
- [ShipStation API v2](https://docs.shipstation.com/apis/openapi)
- [ShipStation v1 add order tag](https://docs.shipstation.com/apis/shipstation-v1/openapi/orders/add_tag_to_order)
- [Anthropic streaming and tool use](https://platform.claude.com/docs/en/build-with-claude/streaming)
