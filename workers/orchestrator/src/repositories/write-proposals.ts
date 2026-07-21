import {
  WriteActionSchema,
  WriteProposalDraftSchema,
  WriteProposalSchema,
  type WriteProposal,
  type WriteProposalDraft,
} from "@resolve/contracts";

export type WriteProposalStatus = "pending" | "confirmed";

export interface StoredWriteProposal extends WriteProposal {
  conversationId: string;
  agentId: number;
  recordVersion: string;
  status: WriteProposalStatus;
}

interface WriteProposalRow {
  id: string;
  conversation_id: string;
  agent_id: number;
  action: string;
  target_id: number;
  before_json: string;
  changes_json: string;
  record_version: string;
  capability_hash: string;
  expires_at: string;
  status: string;
}

interface ConfirmWriteProposalInput {
  id: string;
  capability: string;
  recordVersion: string;
}

export interface CreatedWriteProposal {
  proposal: StoredWriteProposal;
  capability: string;
}

export type ConfirmWriteProposalResult =
  | StoredWriteProposal
  | {
      error:
        | "not_found"
        | "invalid_capability"
        | "expired"
        | "stale"
        | "not_pending";
    };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createCapability(): string {
  return `confirm_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

async function hashCapability(capability: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(capability),
  );
  return hex(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function status(value: string): WriteProposalStatus {
  if (value === "pending" || value === "confirmed") return value;
  throw new Error("Stored write proposal has an invalid status");
}

function mapWriteProposal(row: WriteProposalRow): StoredWriteProposal {
  const proposal = WriteProposalSchema.parse({
    id: row.id,
    action: WriteActionSchema.parse(row.action),
    targetId: row.target_id,
    before: JSON.parse(row.before_json) as unknown,
    changes: JSON.parse(row.changes_json) as unknown,
    expiresAt: row.expires_at,
  });
  return {
    ...proposal,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    recordVersion: row.record_version,
    status: status(row.status),
  };
}

export class WriteProposalRepository {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(
    id: string,
    conversationId: string,
    agentId: number,
    input: WriteProposalDraft,
  ): Promise<CreatedWriteProposal> {
    const draft = WriteProposalDraftSchema.parse(input);
    const capability = createCapability();
    const capabilityHash = await hashCapability(capability);
    const proposal: StoredWriteProposal = {
      id,
      conversationId,
      agentId,
      action: draft.action,
      targetId: draft.targetId,
      before: draft.before,
      changes: draft.changes,
      recordVersion: draft.recordVersion,
      expiresAt: new Date(this.now().getTime() + 10 * 60 * 1_000).toISOString(),
      status: "pending",
    };
    await this.db
      .prepare(
        `INSERT INTO write_proposals
          (id, conversation_id, agent_id, action, target_id, before_json,
           changes_json, record_version, capability_hash, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        proposal.id,
        proposal.conversationId,
        proposal.agentId,
        proposal.action,
        proposal.targetId,
        JSON.stringify(proposal.before),
        JSON.stringify(proposal.changes),
        proposal.recordVersion,
        capabilityHash,
        proposal.expiresAt,
        proposal.status,
      )
      .run();
    return { proposal, capability };
  }

  async get(id: string): Promise<StoredWriteProposal | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM write_proposals WHERE id = ?")
      .bind(id)
      .first<WriteProposalRow>();
    return row ? mapWriteProposal(row) : undefined;
  }

  async confirm(
    input: ConfirmWriteProposalInput,
  ): Promise<ConfirmWriteProposalResult> {
    const proposal = await this.get(input.id);
    if (!proposal) return { error: "not_found" };
    if (proposal.status !== "pending") return { error: "not_pending" };
    const row = await this.db
      .prepare("SELECT capability_hash FROM write_proposals WHERE id = ?")
      .bind(input.id)
      .first<Pick<WriteProposalRow, "capability_hash">>();
    const suppliedHash = await hashCapability(input.capability);
    if (!row || !constantTimeEqual(row.capability_hash, suppliedHash)) {
      return { error: "invalid_capability" };
    }
    if (new Date(proposal.expiresAt).getTime() <= this.now().getTime()) {
      return { error: "expired" };
    }
    if (proposal.recordVersion !== input.recordVersion) {
      return { error: "stale" };
    }

    const updated = await this.db
      .prepare(
        `UPDATE write_proposals
         SET status = 'confirmed', capability_hash = ''
         WHERE id = ? AND status = 'pending' AND capability_hash = ?`,
      )
      .bind(input.id, row.capability_hash)
      .run();
    if (updated.meta.changes !== 1) return { error: "not_pending" };
    return { ...proposal, status: "confirmed" };
  }
}
