import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, sql } from 'drizzle-orm';
import type {
  BotStatusRecord,
  ConversationStatusRecord,
  BotStatusRequest,
  ConversationStatusRequest,
  Capability,
} from '@kilocode/kilo-chat';
import { botStatus, conversationStatus } from '../db/sandbox-status-schema';
import migrations from '../../drizzle/sandbox-status/migrations';

// Defensive parser: the column stores a JSON-encoded Capability[] (or NULL).
// Malformed JSON or non-array shapes return undefined so a corrupt row never
// breaks bot status reads.
function parseCapabilities(raw: string | null): Capability[] | undefined {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every(c => typeof c === 'string')) return undefined;
    return parsed as Capability[];
  } catch {
    return undefined;
  }
}

// Internal RPC input shapes derived from the shared zod schemas. The
// conversation-status request body has no conversationId (it lives in the
// URL); the DO key needs the full row, so we compose it here.
export type PutBotStatusInput = BotStatusRequest;
export type PutConversationStatusInput = ConversationStatusRequest & { conversationId: string };

export class SandboxStatusDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  // Monotonic upsert: a late retry or clock-skewed replica must not roll `at`
  // backwards. `setWhere` scopes the UPDATE branch of ON CONFLICT to rows
  // where the incoming `at` is strictly newer.
  putBotStatus(input: PutBotStatusInput): void {
    const updatedAt = Date.now();
    const capabilities =
      input.capabilities && input.capabilities.length > 0
        ? JSON.stringify(input.capabilities)
        : null;
    this.db
      .insert(botStatus)
      .values({ id: 1, online: input.online, at: input.at, updatedAt, capabilities })
      .onConflictDoUpdate({
        target: botStatus.id,
        set: { online: input.online, at: input.at, updatedAt, capabilities },
        setWhere: sql`${botStatus.at} < excluded.at`,
      })
      .run();
  }

  getBotStatus(): BotStatusRecord | null {
    const row = this.db.select().from(botStatus).where(eq(botStatus.id, 1)).get();
    if (!row) return null;
    const capabilities = parseCapabilities(row.capabilities);
    return {
      online: row.online,
      at: row.at,
      updatedAt: row.updatedAt,
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
  }

  putConversationStatus(input: PutConversationStatusInput): void {
    const updatedAt = Date.now();
    this.db
      .insert(conversationStatus)
      .values({
        conversationId: input.conversationId,
        contextTokens: input.contextTokens,
        contextWindow: input.contextWindow,
        model: input.model,
        provider: input.provider,
        at: input.at,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: conversationStatus.conversationId,
        set: {
          contextTokens: input.contextTokens,
          contextWindow: input.contextWindow,
          model: input.model,
          provider: input.provider,
          at: input.at,
          updatedAt,
        },
        setWhere: sql`${conversationStatus.at} < excluded.at`,
      })
      .run();
  }

  getConversationStatus(conversationId: string): ConversationStatusRecord | null {
    const row = this.db
      .select()
      .from(conversationStatus)
      .where(eq(conversationStatus.conversationId, conversationId))
      .get();
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      contextTokens: row.contextTokens,
      contextWindow: row.contextWindow,
      model: row.model,
      provider: row.provider,
      at: row.at,
      updatedAt: row.updatedAt,
    };
  }

  // Delete rows rather than ctx.storage.deleteAll(): the latter drops every
  // SQLite table including data tables, and migrate() runs only once per DO
  // instance (in the constructor), so subsequent reads on the same instance
  // would hit "no such table" instead of returning null.
  destroy(): void {
    this.db.transaction(tx => {
      tx.delete(botStatus).run();
      tx.delete(conversationStatus).run();
    });
  }
}
