import { eq, and } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';

import type { Env } from './env';
import { SessionItemSchema, type SessionDataItem } from './types/session-sync';
import { getItemIdentity } from './util/compaction';
import {
  INGEST_CHUNK_MAX_BYTES,
  INGEST_CHUNK_MAX_ITEMS,
  MAX_INGEST_ITEM_BYTES,
} from './util/ingest-limits';
import { getSessionIngestDO, type IngestResult } from './dos/SessionIngestDO';
import { withDORetry } from '@kilocode/worker-utils';
import { applyMetadataChanges, flushPartialMetadataChanges } from './ingest/metadata';
export { createItemExtractor } from './ingest/item-extractor';
import { createItemExtractor } from './ingest/item-extractor';

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
async function processMessage(
  env: Env,
  msg: IngestQueueMessage,
  ctx: ExecutionContext
): Promise<void> {
  if (await deleteStagingObjectIfSessionMissing(env, msg)) return;

  const body = await getStagingObjectBody(env, msg.r2Key);
  const mergedChanges = new Map<string, string | null>();

  try {
    const accepted = await ingestStagedSessionItems(env, msg, body, mergedChanges);
    if (accepted) {
      await applyMetadataChanges(env, msg.kiloUserId, msg.sessionId, mergedChanges, ctx);
    }
  } catch (err) {
    // An earlier chunk may have committed to the DO before a later chunk (or the
    // JSON parse) failed. The DO reports a metadata change only when its stored
    // value differs, so on retry those already-persisted values won't be
    // re-emitted — Postgres would never catch up. Flush what we have now so the
    // two stores stay in sync. Best-effort: never mask the original error.
    await flushPartialMetadataChanges(env, msg, mergedChanges, ctx);
    throw err;
  }

  await env.SESSION_INGEST_R2.delete(msg.r2Key);
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
): Promise<boolean> {
  const chunker = createIngestChunker(env, msg, mergedChanges);
  const parseError = await streamSessionItems(msg.r2Key, body, rawItem => chunker.stage(rawItem));

  if (parseError) {
    throw new Error(`Malformed JSON in staging object ${msg.r2Key}: ${parseError.message}`);
  }

  // Handle any remaining items not flushed yet.
  await chunker.flushChunkToSessionDO();
  return chunker.wasAccepted();
}

async function streamSessionItems(
  r2Key: string,
  body: ReadableStream<Uint8Array>,
  onItem: (rawItem: Record<string, unknown>) => Promise<boolean>
): Promise<Error | null> {
  const { tokenizer, pending, getParseError } = createItemExtractor(r2Key);
  const reader = body.getReader();
  let completed = false;

  try {
    while (true) {
      const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
      if (result.done) {
        tokenizer.end();
        completed = true;
      } else {
        tokenizer.write(result.value);
      }

      while (pending.length > 0) {
        const rawItem = pending.shift();
        if (!rawItem) break;
        if (!(await onItem(rawItem))) return null;
      }

      if (result.done) break;
    }

    return getParseError();
  } finally {
    if (!completed) {
      await reader.cancel().catch(err => {
        console.warn('Failed to cancel queue consumer R2 stream', {
          r2Key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    reader.releaseLock();
  }
}

function slimItemForR2Reference(item: SessionDataItem): SessionDataItem {
  switch (item.type) {
    case 'message':
      return { type: 'message', data: { id: item.data.id } };
    case 'part':
      return { type: 'part', data: { id: item.data.id, messageID: item.data.messageID } };
    case 'session': {
      const data: Record<string, unknown> = {};
      if ('title' in item.data) data.title = item.data.title;
      if ('parentID' in item.data) data.parentID = item.data.parentID;
      return { type: 'session', data };
    }
    case 'session_diff':
      return { type: 'session_diff', data: [] };
    case 'model':
      return { type: 'model', data: [] };
    case 'session_open':
    case 'session_close':
    case 'session_status':
    case 'kilo_meta':
      return item;
  }
}

function createIngestChunker(
  env: Env,
  msg: IngestQueueMessage,
  mergedChanges: Map<string, string | null>
) {
  const { r2Key, kiloUserId, sessionId, ingestVersion, ingestedAt } = msg;
  const encoder = new TextEncoder();
  const chunk: SessionDataItem[] = [];
  const chunkItemIds = new Set<string>();
  let chunkR2References: Record<string, string> = {};
  let chunkBytes = 0;
  let accepted = true;

  const flushChunkToSessionDO = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const items = chunk.splice(0);
    const r2References = Object.keys(chunkR2References).length > 0 ? chunkR2References : undefined;
    chunkItemIds.clear();
    chunkR2References = {};
    chunkBytes = 0;

    const ingestResult = await withDORetry<ReturnType<typeof getSessionIngestDO>, IngestResult>(
      () => getSessionIngestDO(env, { kiloUserId, sessionId }),
      async stub =>
        stub.ingest(items, kiloUserId, sessionId, ingestVersion, ingestedAt, r2References),
      'SessionIngestDO.ingest'
    );
    if (ingestResult.accepted === false) {
      accepted = false;
      return;
    }
    for (const change of ingestResult.changes) {
      mergedChanges.set(change.name, change.value);
    }
  };

  const stage = async (rawItem: Record<string, unknown>): Promise<boolean> => {
    if (!accepted) return false;
    const parsed = SessionItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      console.warn('Skipping invalid item in queue consumer', {
        r2Key,
        type: rawItem['type'],
        errors: parsed.error.issues.map(i => i.message),
      });
      return true;
    }

    const item = parsed.data;
    const { item_id } = getItemIdentity(item);

    const itemDataJson = JSON.stringify(item.data);
    const itemDataBytes = encoder.encode(itemDataJson).byteLength;

    if (chunkItemIds.has(item_id)) {
      await flushChunkToSessionDO();
      if (!accepted) return false;
    }

    // Offload data above the DO SQLite row limit to R2; the DO stores a
    // reference and an empty inline blob. Send only identity fields over RPC so
    // a single oversized item cannot exceed Cloudflare's RPC payload limit.
    const itemForRpc = itemDataBytes > MAX_INGEST_ITEM_BYTES ? slimItemForR2Reference(item) : item;
    const itemForRpcDataBytes =
      itemDataBytes > MAX_INGEST_ITEM_BYTES
        ? encoder.encode(JSON.stringify(itemForRpc.data)).byteLength
        : itemDataBytes;
    if (itemDataBytes > MAX_INGEST_ITEM_BYTES) {
      const itemR2Key = `items/${kiloUserId}/${sessionId}/${item_id}/${ingestedAt}`;
      await env.SESSION_INGEST_R2.put(itemR2Key, itemDataJson);
      chunkR2References[item_id] = itemR2Key;
    }

    chunk.push(itemForRpc);
    chunkItemIds.add(item_id);
    chunkBytes += itemForRpcDataBytes;
    if (chunk.length >= INGEST_CHUNK_MAX_ITEMS || chunkBytes >= INGEST_CHUNK_MAX_BYTES) {
      await flushChunkToSessionDO();
    }
    return accepted;
  };

  return { stage, flushChunkToSessionDO, wasAccepted: () => accepted };
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
