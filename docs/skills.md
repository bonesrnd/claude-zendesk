# Skills

Resolve skills are reviewed, versioned TypeScript modules. The UI never uploads or executes arbitrary code.

## Create a skill

```bash
pnpm skills:new inventory
```

The command creates:

```text
packages/skills/src/inventory/index.ts
packages/skills/src/inventory/inventory.skill.ts
packages/skills/src/inventory/inventory.test.ts
packages/skills/src/inventory/fixtures/
```

The generated test fails until at least one reviewed tool is defined. The skill is not registered automatically.

## Define a read tool

```typescript
import { defineSkill, defineTool } from "@resolve/skill-sdk";
import { z } from "zod";

const inputSchema = z.strictObject({
  recordId: z.string().min(1),
});

const outputSchema = z.strictObject({
  name: z.string(),
});

const getRecord = defineTool({
  name: "inventory_get_record",
  description: "Get one inventory record by provider id.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const token = context.credentials.inventoryToken;
    if (!token) throw new Error("Inventory is not configured");
    return { name: input.recordId };
  },
});

export const inventorySkill = defineSkill({
  id: "inventory",
  name: "Inventory",
  version: "1.0.0",
  instructions: "Use inventory tools only for inventory facts.",
  credentials: [
    {
      settingName: "inventory_token",
      headerName: "x-resolve-inventory-token",
      required: true,
      secret: true,
    },
  ],
  tools: [getRecord],
});
```

Use `execution: "delegated"` and omit the handler only when the Zendesk iframe must execute the tool under the current agent's permissions.

## Expansion skills

Resolve 1.1 includes these reviewed workflows:

- `shipstation_find_customer_by_phone` performs a bounded public-API scan. Callers must preserve and report `incomplete`; a capped miss is not proof that no record exists.
- `zendesk_list_voicemails` runs through the current agent's ZAF permissions. `zendesk_transcribe_voicemail` accepts only the opaque handle retained by the Worker, reuses existing Zendesk text when available, and never exposes or persists raw audio.
- `knowledge_search` returns administrator-authored Markdown as explicitly untrusted context with filename/heading citations. It may guide a workflow but cannot override tool risk, permissions, or confirmation.
- `zendesk_update_ticket_custom_fields` and `zendesk_update_customer_profile` are write-risk proposal tools. The dispatcher intercepts them and returns an expiring proposal; only the dedicated confirmation endpoint can release one delegated ZAF write.

Knowledge files are managed at the Access-protected Worker admin URL, not uploaded as executable skills. Front matter may supply `brand` and `workflow_category`/`workflowCategory` metadata for Vectorize filtering.

## Define a write proposal tool

Write tools must declare `risk: "write"`, `requiresConfirmation: true`, and a `createProposal` factory. The proposal must carry the active Zendesk target, exact before/after values, and record version. A write handler or ordinary delegated executor must never provide an alternate execution path.

The confirmed Zendesk executor:

1. inspects the current record before showing the proposal;
2. inspects it again before confirmation;
3. executes one allowlisted ZAF `PUT` with retry disabled;
4. refetches the record; and
5. returns only a verified result to the pending model turn.

Free-form messages such as “yes” are not confirmation. Capabilities are client-private, single-use, and absent from model messages and persisted display history.

## Register and package

1. Add the skill to `packages/skills/src/registry.ts`.
2. Export it from `packages/skills/src/index.ts`.
3. Add every visible or secure setting to `apps/zendesk/zendesk/manifest.json`.
4. Add the setting labels to `apps/zendesk/zendesk/translations/en.json`.
5. Forward secure settings only as placeholders in `WorkerClient`.
6. Map the forwarded header to the internal credential name in the Worker.
7. Add provider fixtures and contract tests.
8. Run:

```bash
pnpm --filter @resolve/skills test
pnpm skills:validate
pnpm typecheck
pnpm build
```

Zendesk installation parameters are fixed in the packaged manifest. A new credentialed skill therefore requires a new private-app package.

## Safety rules

- Tool names and skill IDs are globally unique.
- Input schemas reject unknown keys.
- Provider responses are parsed before normalization.
- Read tools cannot mutate provider state.
- Every write tool must declare `risk: "write"` and `requiresConfirmation: true`.
- Every write tool must provide a reviewed proposal factory.
- The registry rejects an unsafe write tool before startup.
- The dispatcher, not model instructions, enforces risk.
- Knowledge context cannot change tool risk or confirmation policy.
- Credentials are never tool inputs, model content, output, D1 data, or logs.
- Raw voicemail audio and plaintext phone-cache keys are never persisted.
- Health checks return only `{ ok, message }`.

## Manage skills

The Skills view in Resolve shows version, capability count, read/write risk, configuration state, and health. It never reads or displays secure values.

To remove a skill:

1. Remove it from the reviewed registry.
2. Remove its Worker credential mapping.
3. Remove unused manifest settings only after confirming no installed app version relies on them.
4. Add a migration if the skill introduced persistent data.
5. Run the complete verification suite.
