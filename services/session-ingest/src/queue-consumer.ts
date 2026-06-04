import { eq, and, sql } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';

import type { Env } from './env';
import { SessionItemSchema, type SessionDataItem } from './types/session-sync';
import { getItemIdentity } from './util/compaction';
import { MAX_INGEST_ITEM_BYTES, MAX_SINGLE_ITEM_BYTES } from './util/ingest-limits';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { withDORetry, normalizeGitUrl } from '@kilocode/worker-utils';
import { mapSessionEventRow, notifyUserSessionEvent } from './session-events';
import { SessionStatusSchema } from './types/user-connection-protocol';

export interface IngestQueueMessage {
  r2Key: string;
  kiloUserId: string;
  sessionId: string;
  ingestVersion: number;
  ingestedAt: number;
}

export const QUEUE_RETRY_DELAY_SECONDS = 5 * 60;

// A queue message is an envelope for one POST's R2 payload for one session.
// That payload can contain many session items. Batch those items into chunked
// ingest() RPCs to that session's DO instead of one RPC per item. Prod snapshot
// (2026-06-03): p99 is ~13 items / ~1.7 MiB, so ~99% fit in one chunk; only
// ~0.3% (>4 MiB) split. These caps bound memory and RPC size.
const INGEST_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
const INGEST_CHUNK_MAX_ITEMS = 128;

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

async function processMessage(
  env: Env,
  msg: IngestQueueMessage,
  ctx: ExecutionContext
): Promise<void> {
  if (await deleteStagingObjectIfSessionMissing(env, msg)) return;

  const body = await getStagingObjectBody(env, msg.r2Key);
  const mergedChanges = new Map<string, string | null>();

  try {
    await ingestStagedSessionItems(env, msg, body, mergedChanges);
  } catch (err) {
    // An earlier chunk may have committed to the DO before a later chunk (or the
    // JSON parse) failed. The DO reports a metadata change only when its stored
    // value differs, so on retry those already-persisted values won't be
    // re-emitted — Postgres would never catch up. Flush what we have now so the
    // two stores stay in sync. Best-effort: never mask the original error.
    await flushPartialMetadataChanges(env, msg, mergedChanges, ctx);
    throw err;
  }

  await applyMetadataChanges(env, msg.kiloUserId, msg.sessionId, mergedChanges, ctx);
  await env.SESSION_INGEST_R2.delete(msg.r2Key);
}

async function flushPartialMetadataChanges(
  env: Env,
  msg: IngestQueueMessage,
  mergedChanges: Map<string, string | null>,
  ctx: ExecutionContext
): Promise<void> {
  if (mergedChanges.size === 0) return;
  try {
    await applyMetadataChanges(env, msg.kiloUserId, msg.sessionId, mergedChanges, ctx);
  } catch (err) {
    console.error('Failed to flush partial metadata changes after ingest error', {
      r2Key: msg.r2Key,
      sessionId: msg.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function deleteStagingObjectIfSessionMissing(
  env: Env,
  msg: IngestQueueMessage
): Promise<boolean> {
  const { r2Key, kiloUserId, sessionId } = msg;

  // Guard: skip processing if the session has been deleted since this message was queued
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const sessionRows = await db
    .select({ session_id: cli_sessions_v2.session_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
    )
    .limit(1);

  if (sessionRows[0]) return false;

  console.warn('Session no longer exists, cleaning up staging object', { r2Key, sessionId });
  await env.SESSION_INGEST_R2.delete(r2Key);
  return true;
}

async function getStagingObjectBody(env: Env, r2Key: string): Promise<ReadableStream<Uint8Array>> {
  const obj = await env.SESSION_INGEST_R2.get(r2Key);
  if (!obj) {
    throw new Error(`R2 staging object not found: ${r2Key}`);
  }
  // R2 types the body as ReadableStream<any>; staging objects are always byte streams.
  return obj.body as ReadableStream<Uint8Array>;
}

async function ingestStagedSessionItems(
  env: Env,
  msg: IngestQueueMessage,
  body: ReadableStream<Uint8Array>,
  mergedChanges: Map<string, string | null>
): Promise<void> {
  const chunker = createIngestChunker(env, msg, mergedChanges);
  const parseError = await streamSessionItems(msg.r2Key, body, rawItem => chunker.stage(rawItem));

  if (parseError) {
    throw new Error(`Malformed JSON in staging object ${msg.r2Key}: ${parseError.message}`);
  }

  // Handle any remaining items not flushed yet.
  await chunker.flushChunkToSessionDO();
}

async function streamSessionItems(
  r2Key: string,
  body: ReadableStream<Uint8Array>,
  onItem: (rawItem: Record<string, unknown>) => Promise<void>
): Promise<Error | null> {
  const { tokenizer, pending, getParseError } = createItemExtractor(r2Key);
  const reader = body.getReader();

  while (true) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) {
      tokenizer.end();
    } else {
      tokenizer.write(result.value);
    }

    while (pending.length > 0) {
      const rawItem = pending.shift();
      if (!rawItem) break;
      await onItem(rawItem);
    }

    if (result.done) break;
  }

  return getParseError();
}

function createIngestChunker(
  env: Env,
  msg: IngestQueueMessage,
  mergedChanges: Map<string, string | null>
) {
  const { r2Key, kiloUserId, sessionId, ingestVersion, ingestedAt } = msg;
  const encoder = new TextEncoder();
  const chunk: SessionDataItem[] = [];
  let chunkR2References: Record<string, string> = {};
  let chunkBytes = 0;

  const flushChunkToSessionDO = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const items = chunk.splice(0);
    const r2References = Object.keys(chunkR2References).length > 0 ? chunkR2References : undefined;
    chunkR2References = {};
    chunkBytes = 0;

    const ingestResult = await withDORetry(
      () => getSessionIngestDO(env, { kiloUserId, sessionId }),
      stub => stub.ingest(items, kiloUserId, sessionId, ingestVersion, ingestedAt, r2References),
      'SessionIngestDO.ingest'
    );
    for (const change of ingestResult.changes) {
      mergedChanges.set(change.name, change.value);
    }
  };

  const stage = async (rawItem: Record<string, unknown>): Promise<void> => {
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

    // Offload data above the DO SQLite row limit to R2; the DO stores a
    // reference and an empty inline blob.
    const itemDataJson = JSON.stringify(item.data);
    const itemDataBytes = encoder.encode(itemDataJson).byteLength;
    if (itemDataBytes > MAX_INGEST_ITEM_BYTES) {
      const itemR2Key = `items/${kiloUserId}/${sessionId}/${item_id}/${ingestedAt}`;
      await env.SESSION_INGEST_R2.put(itemR2Key, itemDataJson);
      chunkR2References[item_id] = itemR2Key;
    }

    chunk.push(item);
    chunkBytes += itemDataBytes;
    if (chunk.length >= INGEST_CHUNK_MAX_ITEMS || chunkBytes >= INGEST_CHUNK_MAX_BYTES) {
      await flushChunkToSessionDO();
    }
  };

  return { stage, flushChunkToSessionDO };
}

type SessionMetadataUpdates = Partial<
  Pick<
    typeof cli_sessions_v2.$inferInsert,
    | 'title'
    | 'created_on_platform'
    | 'organization_id'
    | 'git_url'
    | 'git_branch'
    | 'status'
    | 'status_updated_at'
  >
>;

/**
 * Build the `cli_sessions_v2` partial update from a set of metadata changes.
 *
 * `git_url` is passed through `normalizeGitUrl` on write so that the
 * `github_branch_pull_requests` cache (keyed on the canonical form) can
 * match new sessions without per-read normalization. Status bumps carry
 * `status_updated_at = now()`.
 */
export function computeSessionMetadataUpdates(
  mergedChanges: Map<string, string | null>,
  now: () => string = () => new Date().toISOString()
): SessionMetadataUpdates {
  const updates: SessionMetadataUpdates = {};

  if (mergedChanges.has('title')) {
    updates.title = mergedChanges.get('title') ?? null;
  }
  if (mergedChanges.has('platform')) {
    const platform = mergedChanges.get('platform') ?? null;
    if (platform !== null) updates.created_on_platform = platform;
  }
  if (mergedChanges.has('orgId')) {
    updates.organization_id = mergedChanges.get('orgId') ?? null;
  }
  if (mergedChanges.has('gitUrl')) {
    const gitUrl = mergedChanges.get('gitUrl') ?? null;
    updates.git_url = gitUrl === null ? null : normalizeGitUrl(gitUrl);
  }
  if (mergedChanges.has('gitBranch')) {
    updates.git_branch = mergedChanges.get('gitBranch') ?? null;
  }
  if (mergedChanges.has('status')) {
    updates.status = mergedChanges.get('status') ?? null;
    updates.status_updated_at = now();
  }

  return updates;
}

async function applyMetadataChanges(
  env: Env,
  kiloUserId: string,
  sessionId: string,
  mergedChanges: Map<string, string | null>,
  ctx: ExecutionContext
): Promise<void> {
  if (mergedChanges.size === 0) return;

  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const status = mergedChanges.has('status') ? (mergedChanges.get('status') ?? null) : undefined;
  const updates = computeSessionMetadataUpdates(mergedChanges);
  const parentSessionId = mergedChanges.has('parentId')
    ? (mergedChanges.get('parentId') ?? null)
    : undefined;
  const changedNonStatus =
    mergedChanges.has('title') ||
    mergedChanges.has('platform') ||
    mergedChanges.has('orgId') ||
    mergedChanges.has('gitUrl') ||
    mergedChanges.has('gitBranch') ||
    parentSessionId !== undefined;

  const notification = await db.transaction(async tx => {
    const statusChange =
      status === undefined
        ? { changed: false, previousStatus: null }
        : await (async () => {
            const [statusRow] = await tx
              .select({ status: cli_sessions_v2.status })
              .from(cli_sessions_v2)
              .where(
                and(
                  eq(cli_sessions_v2.session_id, sessionId),
                  eq(cli_sessions_v2.kilo_user_id, kiloUserId)
                )
              )
              .limit(1)
              .for('update');
            if (!statusRow) return null;
            const previousStatus = SessionStatusSchema.nullable().parse(statusRow.status);
            return { changed: status !== previousStatus, previousStatus };
          })();

    if (!statusChange) return null;

    if (Object.keys(updates).length > 0) {
      await tx
        .update(cli_sessions_v2)
        .set(updates)
        .where(
          and(
            eq(cli_sessions_v2.session_id, sessionId),
            eq(cli_sessions_v2.kilo_user_id, kiloUserId)
          )
        );
    }

    if (parentSessionId !== undefined) {
      if (parentSessionId && parentSessionId !== sessionId) {
        const parentRows = await tx
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
          await tx
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
        await tx
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

    if (!changedNonStatus && !statusChange.changed) return null;

    const [persistedRow] = await tx
      .select({
        session_id: cli_sessions_v2.session_id,
        created_at: cli_sessions_v2.created_at,
        updated_at: cli_sessions_v2.updated_at,
        title: cli_sessions_v2.title,
        created_on_platform: cli_sessions_v2.created_on_platform,
        organization_id: cli_sessions_v2.organization_id,
        git_url: cli_sessions_v2.git_url,
        git_branch: cli_sessions_v2.git_branch,
        parent_session_id: cli_sessions_v2.parent_session_id,
        status: cli_sessions_v2.status,
        status_updated_at: cli_sessions_v2.status_updated_at,
      })
      .from(cli_sessions_v2)
      .where(
        and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
      )
      .limit(1);

    if (!persistedRow) return null;

    return {
      changedNonStatus,
      changedStatus: statusChange.changed,
      previousStatus: statusChange.previousStatus,
      session: mapSessionEventRow(persistedRow),
    };
  });
  if (!notification) return;

  if (notification.changedNonStatus) {
    notifyUserSessionEvent(
      env,
      kiloUserId,
      {
        type: 'session.updated',
        data: {
          source: 'v2',
          session: notification.session,
          changedAt: notification.session.updatedAt,
        },
      },
      ctx
    );
  }
  if (notification.changedStatus) {
    notifyUserSessionEvent(
      env,
      kiloUserId,
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session: notification.session,
          previousStatus: notification.previousStatus,
          status: notification.session.status,
          statusUpdatedAt: notification.session.statusUpdatedAt,
          changedAt: notification.session.updatedAt,
        },
      },
      ctx
    );
  }
}

export async function queue(
  batch: MessageBatch<IngestQueueMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(env, msg.body, ctx);
      msg.ack();
    } catch (err) {
      console.error('Queue message processing failed, will retry', {
        r2Key: msg.body.r2Key,
        sessionId: msg.body.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
    }
  }
}
