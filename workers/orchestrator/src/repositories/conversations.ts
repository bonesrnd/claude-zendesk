import {
  CitationSchema,
  ToolEventSchema,
  type Citation,
  type ToolEvent,
} from "@resolve/contracts";
import { z } from "zod";

export type MessageRole = "user" | "assistant";
export type ToolRunStatus = "running" | "succeeded" | "failed";

export interface Conversation {
  id: string;
  tenantKey: string;
  ticketId: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  agentId?: number;
  agentName?: string;
  citations: Citation[];
  toolEvents: ToolEvent[];
  createdAt: string;
}

export interface StoredToolRun {
  id: string;
  conversationId: string;
  messageId?: string;
  skillId: string;
  toolName: string;
  status: ToolRunStatus;
  requestSummary: unknown;
  resultSummary?: unknown;
  safeErrorCode?: string;
  createdAt: string;
  completedAt?: string;
}

interface ConversationRow {
  id: string;
  tenant_key: string;
  ticket_id: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  agent_id: number | null;
  agent_name: string | null;
  citations_json: string;
  tool_events_json: string;
  created_at: string;
}

interface ToolRunRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  skill_id: string;
  tool_name: string;
  status: ToolRunStatus;
  request_summary_json: string;
  result_summary_json: string | null;
  safe_error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    ticketId: row.ticket_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(row.agent_name === null ? {} : { agentName: row.agent_name }),
    citations: z.array(CitationSchema).parse(JSON.parse(row.citations_json)),
    toolEvents: z
      .array(ToolEventSchema)
      .parse(JSON.parse(row.tool_events_json)),
    createdAt: row.created_at,
  };
}

function mapToolRun(row: ToolRunRow): StoredToolRun {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    ...(row.message_id === null ? {} : { messageId: row.message_id }),
    skillId: row.skill_id,
    toolName: row.tool_name,
    status: row.status,
    requestSummary: JSON.parse(row.request_summary_json) as unknown,
    ...(row.result_summary_json === null
      ? {}
      : {
          resultSummary: JSON.parse(row.result_summary_json) as unknown,
        }),
    ...(row.safe_error_code === null
      ? {}
      : { safeErrorCode: row.safe_error_code }),
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class ConversationRepository {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(tenantKey: string, ticketId: number): Promise<Conversation> {
    const id = `conv_${crypto.randomUUID()}`;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + 90 * 24 * 60 * 60 * 1_000);
    const value: Conversation = {
      id,
      tenantKey,
      ticketId,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await this.db
      .prepare(
        `INSERT INTO conversations
          (id, tenant_key, ticket_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        value.id,
        value.tenantKey,
        value.ticketId,
        value.createdAt,
        value.updatedAt,
        value.expiresAt,
      )
      .run();

    return value;
  }

  async get(
    tenantKey: string,
    conversationId: string,
  ): Promise<Conversation | undefined> {
    const row = await this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE tenant_key = ? AND id = ?`,
      )
      .bind(tenantKey, conversationId)
      .first<ConversationRow>();
    return row ? mapConversation(row) : undefined;
  }

  async listForTicket(
    tenantKey: string,
    ticketId: number,
  ): Promise<Conversation[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE tenant_key = ? AND ticket_id = ?
         ORDER BY updated_at DESC, id DESC`,
      )
      .bind(tenantKey, ticketId)
      .all<ConversationRow>();
    return result.results.map(mapConversation);
  }

  async appendMessage(
    conversationId: string,
    input: {
      role: MessageRole;
      content: string;
      agent?: { id: number; name: string };
      citations?: Citation[];
      toolEvents?: ToolEvent[];
    },
  ): Promise<StoredMessage> {
    const createdAt = this.now().toISOString();
    const message: StoredMessage = {
      id: `msg_${crypto.randomUUID()}`,
      conversationId,
      role: input.role,
      content: input.content,
      ...(input.agent
        ? { agentId: input.agent.id, agentName: input.agent.name }
        : {}),
      citations: input.citations ?? [],
      toolEvents: input.toolEvents ?? [],
      createdAt,
    };
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO messages
            (id, conversation_id, role, content, agent_id, agent_name,
             citations_json, tool_events_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.agentId ?? null,
          message.agentName ?? null,
          JSON.stringify(message.citations),
          JSON.stringify(message.toolEvents),
          message.createdAt,
        ),
      this.db
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(createdAt, conversationId),
    ]);
    return message;
  }

  async listMessages(
    tenantKey: string,
    conversationId: string,
  ): Promise<StoredMessage[]> {
    const result = await this.db
      .prepare(
        `SELECT messages.*
         FROM messages
         JOIN conversations ON conversations.id = messages.conversation_id
         WHERE conversations.tenant_key = ? AND conversations.id = ?
         ORDER BY messages.created_at ASC, messages.id ASC`,
      )
      .bind(tenantKey, conversationId)
      .all<MessageRow>();
    return result.results.map(mapMessage);
  }

  async appendToolRun(
    conversationId: string,
    input: {
      messageId?: string;
      skillId: string;
      toolName: string;
      requestSummary: unknown;
    },
  ): Promise<StoredToolRun> {
    const run: StoredToolRun = {
      id: `tool_${crypto.randomUUID()}`,
      conversationId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      skillId: input.skillId,
      toolName: input.toolName,
      status: "running",
      requestSummary: input.requestSummary,
      createdAt: this.now().toISOString(),
    };
    await this.db
      .prepare(
        `INSERT INTO tool_runs
          (id, conversation_id, message_id, skill_id, tool_name, status,
           request_summary_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        run.id,
        run.conversationId,
        run.messageId ?? null,
        run.skillId,
        run.toolName,
        run.status,
        JSON.stringify(run.requestSummary),
        run.createdAt,
      )
      .run();
    return run;
  }

  async completeToolRun(
    id: string,
    input: {
      status: Exclude<ToolRunStatus, "running">;
      resultSummary?: unknown;
      safeErrorCode?: string;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tool_runs
         SET status = ?, result_summary_json = ?, safe_error_code = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.status,
        input.resultSummary === undefined
          ? null
          : JSON.stringify(input.resultSummary),
        input.safeErrorCode ?? null,
        this.now().toISOString(),
        id,
      )
      .run();
  }

  async listToolRuns(
    tenantKey: string,
    conversationId: string,
  ): Promise<StoredToolRun[]> {
    const result = await this.db
      .prepare(
        `SELECT tool_runs.*
         FROM tool_runs
         JOIN conversations ON conversations.id = tool_runs.conversation_id
         WHERE conversations.tenant_key = ? AND conversations.id = ?
         ORDER BY tool_runs.created_at ASC, tool_runs.id ASC`,
      )
      .bind(tenantKey, conversationId)
      .all<ToolRunRow>();
    return result.results.map(mapToolRun);
  }

  async deleteExpired(at = this.now()): Promise<number> {
    const cutoff = at.toISOString();
    const count = await this.db
      .prepare(
        "SELECT COUNT(*) AS conversation_count FROM conversations WHERE expires_at <= ?",
      )
      .bind(cutoff)
      .first<{ conversation_count: number }>();
    await this.db
      .prepare("DELETE FROM conversations WHERE expires_at <= ?")
      .bind(cutoff)
      .run();
    return count?.conversation_count ?? 0;
  }
}
