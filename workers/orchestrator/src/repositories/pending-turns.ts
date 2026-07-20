export interface PendingTurn {
  id: string;
  conversationId: string;
  state: unknown;
  createdAt: string;
  expiresAt: string;
}

interface PendingTurnRow {
  id: string;
  conversation_id: string;
  state_json: string;
  created_at: string;
  expires_at: string;
}

function mapPendingTurn(row: PendingTurnRow): PendingTurn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    state: JSON.parse(row.state_json) as unknown,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class PendingTurnRepository {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async save(conversationId: string, state: unknown): Promise<PendingTurn> {
    const createdAt = this.now();
    const value: PendingTurn = {
      id: `turn_${crypto.randomUUID()}`,
      conversationId,
      state,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 10 * 60 * 1_000).toISOString(),
    };
    await this.db
      .prepare(
        `INSERT INTO pending_turns
          (id, conversation_id, state_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        value.id,
        value.conversationId,
        JSON.stringify(value.state),
        value.createdAt,
        value.expiresAt,
      )
      .run();
    return value;
  }

  async consume(id: string): Promise<PendingTurn | undefined> {
    const row = await this.db
      .prepare("SELECT * FROM pending_turns WHERE id = ?")
      .bind(id)
      .first<PendingTurnRow>();
    if (!row) return undefined;

    await this.db
      .prepare("DELETE FROM pending_turns WHERE id = ?")
      .bind(id)
      .run();
    return mapPendingTurn(row);
  }

  async deleteExpired(at = this.now()): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM pending_turns WHERE expires_at <= ?")
      .bind(at.toISOString())
      .run();
    return result.meta.changes;
  }
}
