import { eq, and, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';

import type { Env } from './env';
import { SessionItemSchema } from './types/session-sync';
import { getItemIdentity } from './util/compaction';
import { MAX_INGEST_ITEM_BYTES, MAX_SINGLE_ITEM_BYTES } from './util/ingest-limits';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { withDORetry } from '@kilocode/worker-utils';

export interface IngestQueueMessage {
  r2Key: string;
  kiloUserId: string;
  sessionId: string;
  ingestVersion: number;
  ingestedAt: number;
}

/**
 * Creates a streaming item extractor that uses a low-level Tokenizer to parse
 * items from `$.data[]` one at a time, with a per-item byte budget.
 *
 * Items within budget get their tokens fed to a fresh TokenParser that builds
 * the JS object. Oversized items have their tokens discarded without ever
 * materializing a JS object.
 *
 * Peak memory: one R2 chunk + one parsed item (bounded by MAX_SINGLE_ITEM_BYTES).
 */
export function createItemExtractor(r2Key: string) {
  const pending: Record<string, unknown>[] = [];
  let parseError: Error | null = null;

  // Depth: 0=before root, 1=root object, 2=$.data array, 3+=inside an item
  let depth = 0;
  let pendingKey: string | undefined;
  let foundDataArray = false;
  let itemStartOffset = 0;
  let skippingItem = false;
  let itemParser: TokenParser | null = null;

  function startItemParser() {
    itemParser = new TokenParser({ paths: ['$'], keepStack: false });
    itemParser.onValue = ({ value, stack }) => {
      if (stack.length === 0 && value != null) {
        pending.push(value as Record<string, unknown>);
      }
    };
    itemParser.onError = (err: Error) => {
      console.error('TokenParser error in queue consumer', { r2Key, error: err.message });
    };
  }

  const tokenizer = new Tokenizer();
  tokenizer.onToken = ({ token, value, offset }) => {
    const isOpen = token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET;
    const isClose = token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET;

    // --- Skipping an oversized item: just track depth to find closing brace ---
    if (skippingItem) {
      if (isOpen) depth++;
      if (isClose) {
        depth--;
        if (depth === 2) {
          skippingItem = false;
        }
      }
      return;
    }

    // --- Inside an item (depth >= 3): feed tokens to item parser with byte budget ---
    if (foundDataArray && depth >= 3) {
      if (offset - itemStartOffset > MAX_SINGLE_ITEM_BYTES) {
        console.warn('Skipping oversized item in queue consumer (byte budget exceeded)', {
          r2Key,
          bytesConsumed: offset - itemStartOffset,
          maxBytes: MAX_SINGLE_ITEM_BYTES,
        });
        skippingItem = true;
        itemParser = null;
        if (isOpen) depth++;
        if (isClose) depth--;
        if (depth === 2) skippingItem = false; // item ended on the trigger token
        return;
      }

      itemParser?.write({ token, value });
      if (isOpen) depth++;
      if (isClose) {
        depth--;
        if (depth === 2) {
          // Item complete — onValue already fired, clean up
          itemParser = null;
        }
      }
      return;
    }

    // --- Structural tokens outside items ---
    if (isOpen) {
      depth++;

      // depth just became 3 inside $.data[] with { → item start
      if (foundDataArray && depth === 3 && token === TokenType.LEFT_BRACE) {
        itemStartOffset = offset;
        startItemParser();
        itemParser?.write({ token, value });
        return;
      }

      // depth just became 2 with [ after "data" key → found $.data array
      if (depth === 2 && token === TokenType.LEFT_BRACKET && pendingKey === 'data') {
        foundDataArray = true;
        pendingKey = undefined;
        return;
      }

      pendingKey = undefined;
      return;
    }

    if (isClose) {
      if (foundDataArray && depth === 2 && token === TokenType.RIGHT_BRACKET) {
        foundDataArray = false;
      }
      depth--;
      return;
    }

    // Track keys at depth 1 (root object properties) to detect "data"
    if (depth === 1 && token === TokenType.STRING) {
      pendingKey = value as string;
    } else if (token !== TokenType.COLON) {
      pendingKey = undefined;
    }
  };

  tokenizer.onError = (err: Error) => {
    console.error('Tokenizer error in queue consumer', { r2Key, error: err.message });
    parseError = err;
  };

  return {
    tokenizer,
    pending,
    getParseError: () => parseError,
  };
}

async function processMessage(env: Env, msg: IngestQueueMessage): Promise<void> {
  const { r2Key, kiloUserId, sessionId, ingestVersion, ingestedAt } = msg;

  // Guard: skip processing if the session has been deleted since this message was queued
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const sessionRows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);
  if (!sessionRows[0]) {
    console.warn('Session no longer exists, cleaning up staging object', { r2Key, sessionId });
    await env.SESSION_INGEST_R2.delete(r2Key);
    return;
  }

  const obj = await env.SESSION_INGEST_R2.get(r2Key);
  if (!obj) {
    throw new Error(`R2 staging object not found: ${r2Key}`);
  }

  const mergedChanges = new Map<string, string | null>();
  const { tokenizer, pending, getParseError } = createItemExtractor(r2Key);

  // Feed the R2 body chunk by chunk, processing completed items between reads
  const reader = obj.body.getReader();
  while (true) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) {
      tokenizer.end();
    } else {
      tokenizer.write(result.value);
    }

    // Process any items completed during this chunk
    while (pending.length > 0) {
      const rawItem = pending.shift();
      if (!rawItem) break;
      try {
        await processItem(
          env,
          rawItem,
          r2Key,
          kiloUserId,
          sessionId,
          ingestVersion,
          ingestedAt,
          mergedChanges
        );
      } catch (err) {
        console.error('Error processing single item in queue consumer, continuing', {
          r2Key,
          type: rawItem['type'],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.done) break;
  }

  // If the JSON payload was malformed, throw so the queue message is retried/DLQ'd
  const parseError = getParseError();
  if (parseError) {
    throw new Error(`Malformed JSON in staging object ${r2Key}: ${parseError.message}`);
  }

  // Update Postgres with metadata changes
  await applyMetadataChanges(env, kiloUserId, sessionId, mergedChanges);

  // Delete staging R2 object on success
  await env.SESSION_INGEST_R2.delete(r2Key);
}

async function processItem(
  env: Env,
  rawItem: Record<string, unknown>,
  r2Key: string,
  kiloUserId: string,
  sessionId: string,
  ingestVersion: number,
  ingestedAt: number,
  mergedChanges: Map<string, string | null>
): Promise<void> {
  // Validate against schema
  const parsed = SessionItemSchema.safeParse(rawItem);
  if (!parsed.success) {
    console.warn('Skipping invalid item in queue consumer', {
      r2Key,
      type: rawItem['type'],
      errors: parsed.error.issues.map(i => i.message),
    });
    return;
  }

  const item = parsed.data;
  const { item_id } = getItemIdentity(item);

  // Check if item data exceeds DO SQLite row limit (use byte length for non-ASCII safety)
  const itemDataJson = JSON.stringify(item.data);
  let r2References: Record<string, string> | undefined;
  if (new TextEncoder().encode(itemDataJson).byteLength > MAX_INGEST_ITEM_BYTES) {
    const itemR2Key = `items/${kiloUserId}/${sessionId}/${item_id}/${ingestedAt}`;
    await env.SESSION_INGEST_R2.put(itemR2Key, itemDataJson);
    r2References = { [item_id]: itemR2Key };
  }

  const ingestResult = await withDORetry(
    () => getSessionIngestDO(env, { kiloUserId, sessionId }),
    stub => stub.ingest([item], kiloUserId, sessionId, ingestVersion, ingestedAt, r2References),
    'SessionIngestDO.ingest'
  );

  for (const change of ingestResult.changes) {
    mergedChanges.set(change.name, change.value);
  }
}

async function applyMetadataChanges(
  env: Env,
  kiloUserId: string,
  sessionId: string,
  mergedChanges: Map<string, string | null>
): Promise<void> {
  if (mergedChanges.size === 0) return;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);

  const title = mergedChanges.has('title') ? (mergedChanges.get('title') ?? null) : undefined;
  const platform = mergedChanges.has('platform')
    ? (mergedChanges.get('platform') ?? null)
    : undefined;
  const orgId = mergedChanges.has('orgId') ? (mergedChanges.get('orgId') ?? null) : undefined;
  const gitUrl = mergedChanges.has('gitUrl') ? (mergedChanges.get('gitUrl') ?? null) : undefined;
  const gitBranch = mergedChanges.has('gitBranch')
    ? (mergedChanges.get('gitBranch') ?? null)
    : undefined;

  const updates: Partial<
    Pick<
      typeof cli_sessions_v2.$inferInsert,
      'title' | 'created_on_platform' | 'organization_id' | 'git_url' | 'git_branch'
    >
  > = {};
  if (title !== undefined) updates.title = title;
  if (platform !== undefined && platform !== null) updates.created_on_platform = platform;
  if (orgId !== undefined) updates.organization_id = orgId;
  if (gitUrl !== undefined) updates.git_url = gitUrl;
  if (gitBranch !== undefined) updates.git_branch = gitBranch;

  if (Object.keys(updates).length > 0) {
    await db
      .update(cli_sessions_v2)
      .set(updates)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      );
  }

  const parentSessionId = mergedChanges.has('parentId')
    ? (mergedChanges.get('parentId') ?? null)
    : undefined;
  if (parentSessionId !== undefined) {
    if (parentSessionId && parentSessionId !== sessionId) {
      const parentRows = await db
        .select({ session_id: cli_sessions_v2.session_id })
        .from(cli_sessions_v2)
        .where(
          and(
            eq(cli_sessions_v2.session_id, parentSessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        )
        .limit(1);

      if (parentRows[0]) {
        await db
          .update(cli_sessions_v2)
          .set({ parent_session_id: parentSessionId })
          .where(
            and(
              eq(cli_sessions_v2.session_id, sessionId),
              eq(cli_sessions_v2.kilo_user_id, kiloUserId),
              sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`
            )
          );
      }
    } else if (parentSessionId === null) {
      await db
        .update(cli_sessions_v2)
        .set({ parent_session_id: null })
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId),
            sql`${cli_sessions_v2.parent_session_id} IS DISTINCT FROM ${parentSessionId}`
          )
        );
    }
  }
}

export async function queue(batch: MessageBatch<IngestQueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(env, msg.body);
      msg.ack();
    } catch (err) {
      console.error('Queue message processing failed, will retry', {
        r2Key: msg.body.r2Key,
        sessionId: msg.body.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}
