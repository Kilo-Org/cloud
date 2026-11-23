import { randomUUID } from 'expo-crypto';
import * as Crypto from 'expo-crypto';
import { Effect, ManagedRuntime, Option } from 'effect';
import { SessionStore, type Turn } from '@kilocode/harness-sdk';
import  { type SQLiteDatabase } from 'expo-sqlite';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { chatLayers, organizationIdOf } from '../layers';
import { enterChat, releaseChat, SYSTEM } from '../registry';
import  { type ChatPlace } from '../scope';
import {
  type ChatDatabase,
  deleteChat,
  modelOfSession,
  recordOfChat,
  rememberChat,
} from '../store';
import { runBackfill } from './sync-backfill';
import { type SyncClient, syncClientFor } from './sync-client';
import {
  type SyncDeps,
  uploadChat,
  type UploadOutcome,
} from './sync-engine';
import { mintServerSessionId } from './sync-ids';
import { portableModelRef } from './sync-mapping';
import { admitTurn, discardDiverged, pullChat } from './sync-pull';
import { chatSyncSourceId, readChatSyncSetting } from './sync-settings';
import { onChatSettled } from './sync-hooks';
import {
  saveSyncRecord,
  stampServerSessionId,
  syncRecordByServerId,
  syncRecordOf,
  unsyncedChatIdsOfScope,
} from './sync-store';

/**
 * Wiring: the engine against the real database, harness store and SDK
 * client, plus the banner status screens read. The gate (flag and the
 * per-account setting) is answered here, once, for every caller.
 */

export type SyncBanner =
  | { readonly kind: 'none' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'live' };

const banners = new Map<string, SyncBanner>();
const bannerListeners = new Set<() => void>();
const NO_BANNER: SyncBanner = { kind: 'none' };

export function bannerOf(sessionId: string): SyncBanner {
  return banners.get(sessionId) ?? NO_BANNER;
}

export function watchBanners(listener: () => void): () => void {
  bannerListeners.add(listener);
  return () => {
    bannerListeners.delete(listener);
  };
}

function setBanner(sessionId: string, banner: SyncBanner): void {
  if (bannerOf(sessionId).kind === banner.kind) {
    return;
  }
  banners.set(sessionId, banner);
  for (const listener of bannerListeners) {
    listener();
  }
}

/** The outcome screens act on when a synced chat was deleted elsewhere. */
export type DeletedElsewhereListener = (sessionId: string) => void;
const deletedListeners = new Set<DeletedElsewhereListener>();

export function onDeletedElsewhere(listener: DeletedElsewhereListener): () => void {
  deletedListeners.add(listener);
  return () => {
    deletedListeners.delete(listener);
  };
}

function announceDeleted(sessionId: string): void {
  for (const listener of deletedListeners) {
    listener(sessionId);
  }
}

const runtimes = new Map<string, ManagedRuntime.ManagedRuntime<unknown, unknown>>();

function runtimeFor(place: ChatPlace, db: SQLiteDatabase) {
  const held = runtimes.get(place.chatScope);
  if (held !== undefined) {
    return held;
  }
  const made = ManagedRuntime.make(chatLayers(db, place.org));
  runtimes.set(place.chatScope, made as ManagedRuntime.ManagedRuntime<unknown, unknown>);
  return made;
}

async function depsFor(place: ChatPlace): Promise<{ deps: SyncDeps; client: SyncClient; db: ChatDatabase }> {
  const database = await encryptedDatabase();
  const db = database as unknown as ChatDatabase;
  const client = syncClientFor(organizationIdOf(place.org));
  const runtime = runtimeFor(place, database);
  const deps: SyncDeps = {
    db,
    transport: client.transport,
    importTurns: async ({ sessionId, turns, model }) => {
      await runtime.runPromise(
        Effect.gen(function* importing() {
          const store = yield* SessionStore;
          const held = yield* store.read(sessionId);
          if (Option.isNone(held)) {
            yield* store.create({ id: sessionId, system: SYSTEM, model });
          }
          yield* store.append({
            sessionId,
            turns: [...turns],
            prompted: Option.isSome(held) ? (held.value.prompted ?? 0) : 0,
          });
          yield* store.flush();
        }) as Effect.Effect<void, unknown>
      );
    },
    forgetLocal: async sessionId => {
      await releaseChat(sessionId);
      deleteChat(db, sessionId);
      setBanner(sessionId, { kind: 'none' });
      announceDeleted(sessionId);
    },
    newBatchId: () => randomUUID(),
    newServerSessionId: () =>
      mintServerSessionId(Date.now(), () => Crypto.getRandomBytes(1)[0] ?? 0),
    now: () => Date.now(),
  };
  return { deps, client, db };
}

/** Whether sync runs for this place: on unless this device stored an off. */
export async function syncSettingOn(place: ChatPlace): Promise<boolean> {
  return (await readChatSyncSetting(place.chatScope)) === 'on';
}

function storedTitle(db: ChatDatabase, sessionId: string): string | null {
  const [row] = db.getAllSync<{ title: string | null }>(
    'select title from chats where session_id = ?',
    [sessionId]
  );
  return row?.title ?? null;
}

function reflect(sessionId: string, outcome: UploadOutcome): void {
  if (outcome.kind === 'diverged') {
    setBanner(sessionId, { kind: 'diverged' });
  } else if (outcome.kind === 'synced' || outcome.kind === 'nothing-to-upload') {
    setBanner(sessionId, { kind: 'none' });
  }
}

/** Uploads one settled chat and answers what happened. Never throws. */
async function uploadNow(
  place: ChatPlace,
  sessionId: string,
  turns: readonly Turn[]
): Promise<UploadOutcome> {
  try {
    const { deps, db } = await depsFor(place);
    const record = syncRecordOf(db, sessionId);
    if (record === null) {
      return { kind: 'unknown-chat' };
    }
    const modelId = modelOfSession(db, sessionId) ?? '';
    const outcome = await uploadChat(deps, {
      sessionId,
      sourceId: await chatSyncSourceId(place.chatScope),
      turns,
      title: storedTitle(db, sessionId),
      model: portableModelRef(modelId),
      modelId,
      agent: 'kilo',
      createdAt: recordOfChat(db, sessionId).createdAt ?? Date.now(),
    });
    reflect(sessionId, outcome);
    return outcome;
  } catch {
    // Sync is a background mirror: a failed upload stays pending in the
    // record and the next settled exchange retries it.
    return { kind: 'pending' };
  }
}

/** Uploads one settled chat. Callers hold the gate; this never throws. */
export async function uploadSettledChat(
  place: ChatPlace,
  sessionId: string,
  turns: readonly Turn[]
): Promise<void> {
  await uploadNow(place, sessionId, turns);
}

/** A rename writes the shared session entity (H3), turns or none. */
export async function uploadRenamedChat(place: ChatPlace, sessionId: string): Promise<void> {
  try {
    const { deps, db } = await depsFor(place);
    if (syncRecordOf(db, sessionId)?.serverSessionId === null) {
      return;
    }
    const modelId = modelOfSession(db, sessionId) ?? '';
    const outcome = await uploadChat(deps, {
      sessionId,
      sourceId: await chatSyncSourceId(place.chatScope),
      turns: [],
      title: storedTitle(db, sessionId),
      model: portableModelRef(modelId),
      modelId,
      agent: 'kilo',
      createdAt: recordOfChat(db, sessionId).createdAt ?? Date.now(),
      metadataOnly: true,
    });
    reflect(sessionId, outcome);
  } catch {
    // As above: the next upload carries the title again.
  }
}

/** Pulls a synced chat on open and reopens it over whatever arrived. */
export async function pullOpenedChat(place: ChatPlace, sessionId: string): Promise<void> {
  try {
    const { deps, db } = await depsFor(place);
    const record = syncRecordOf(db, sessionId);
    if (record === null || record.serverSessionId === null) {
      return;
    }
    if (record.phase === 'diverged') {
      setBanner(sessionId, { kind: 'diverged' });
      return;
    }
    const outcome = await pullChat(deps, {
      sessionId,
      sourceId: await chatSyncSourceId(place.chatScope),
      modelId: modelOfSession(db, sessionId) ?? '',
    });
    if (outcome.kind === 'imported') {
      await releaseChat(sessionId);
      await enterChat(place, sessionId);
    }
  } catch {
    // Offline opens read the local copy; the next turn's admission retries.
  }
}

export type SendDecision =
  | { readonly kind: 'local' }
  | { readonly kind: 'relayed' }
  | { readonly kind: 'blocked'; readonly reason: 'busy' | 'diverged' | 'deleted' | 'unavailable' };

/** H6 before a turn: pull, then run locally, relay to a live runner, or block. */
export async function prepareSend(
  place: ChatPlace,
  sessionId: string,
  text: string
): Promise<SendDecision> {
  try {
    const { deps, client, db } = await depsFor(place);
    const record = syncRecordOf(db, sessionId);
    if (record === null || record.serverSessionId === null || record.phase === 'local') {
      return { kind: 'local' };
    }
    const live = await client.probeLive(record.serverSessionId);
    const admission = await admitTurn(deps, {
      sessionId,
      sourceId: await chatSyncSourceId(place.chatScope),
      modelId: modelOfSession(db, sessionId) ?? '',
      liveElsewhere: live,
    });
    switch (admission.kind) {
      case 'local-turn': {
        setBanner(sessionId, { kind: 'none' });
        return { kind: 'local' };
      }
      case 'live-elsewhere': {
        setBanner(sessionId, { kind: 'live' });
        const sent = await client.sendLiveMessage(record.serverSessionId, text);
        if (sent) {
          void pullOpenedChat(place, sessionId);
          return { kind: 'relayed' };
        }
        return { kind: 'blocked', reason: 'unavailable' };
      }
      case 'busy': {
        setBanner(sessionId, { kind: 'busy' });
        return { kind: 'blocked', reason: 'busy' };
      }
      case 'diverged': {
        setBanner(sessionId, { kind: 'diverged' });
        return { kind: 'blocked', reason: 'diverged' };
      }
      case 'deleted': {
        return { kind: 'blocked', reason: 'deleted' };
      }
      case 'unavailable': {
        return { kind: 'blocked', reason: 'unavailable' };
      }
    }
  } catch {
    return { kind: 'blocked', reason: 'unavailable' };
  }
}

/** Delete everywhere (H8): tombstone first, then the local copy goes. */
export async function deleteEverywhere(
  place: ChatPlace,
  sessionId: string
): Promise<{ readonly kind: 'deleted' } | { readonly kind: 'local-only' } | { readonly kind: 'failed' }> {
  const { deps, client, db } = await depsFor(place);
  const record = syncRecordOf(db, sessionId);
  if (record === null || record.serverSessionId === null) {
    return { kind: 'local-only' };
  }
  const result = await client.deleteSession(record.serverSessionId);
  if (result.type === 'deleted' || result.type === 'not_found') {
    saveSyncRecord(db, sessionId, { phase: 'deleted', outbox: null });
    await deps.forgetLocal(sessionId);
    return { kind: 'deleted' };
  }
  return { kind: 'failed' };
}

/** The diverged banner's way out: drop the local tail, load the server log. */
export async function discardAndReload(
  place: ChatPlace,
  sessionId: string,
  turns: readonly Turn[]
): Promise<string> {
  const { deps, db } = await depsFor(place);
  const outcome = await discardDiverged(deps, {
    sessionId,
    sourceId: await chatSyncSourceId(place.chatScope),
    modelId: modelOfSession(db, sessionId) ?? '',
    turns,
  });
  if (outcome.kind === 'discarded') {
    setBanner(sessionId, { kind: 'none' });
    await releaseChat(sessionId);
    await enterChat(place, sessionId);
    return outcome.restoredText;
  }
  return '';
}

/**
 * Opens one server session locally: the harness session takes the server id
 * itself, so the route, the list row and the server log all name one thing.
 * Answers the session id to open, or null when the import could not start.
 */
export async function importServerSession(
  place: ChatPlace,
  serverSessionId: string,
  modelId: string
): Promise<string | null> {
  const { deps, db } = await depsFor(place);
  const held = syncRecordByServerId(db, serverSessionId);
  if (held !== null) {
    await pullOpenedChat(place, held.sessionId);
    return held.sessionId;
  }
  const sessionId = serverSessionId;
  rememberChat(db, { sessionId, scope: place.chatScope, at: Date.now() });
  const sourceId = await chatSyncSourceId(place.chatScope);
  stampServerSessionId(db, sessionId, serverSessionId, sourceId);
  const outcome = await pullChat(deps, { sessionId, sourceId, modelId });
  if (outcome.kind === 'deleted' || outcome.kind === 'not-found' || outcome.kind === 'unknown-chat') {
    return null;
  }
  await enterChat(place, sessionId);
  return sessionId;
}

const uploaderScopes = new Map<string, number>();
let uploaderOff: (() => void) | null = null;

/**
 * Registers the settled-exchange uploader for one place, once however many
 * screens ask: the list and an open chat both outlive an exchange, and two
 * registrations would upload every exchange twice.
 */
export function registerSyncUploader(place: ChatPlace): () => void {
  const count = (uploaderScopes.get(place.chatScope) ?? 0) + 1;
  uploaderScopes.set(place.chatScope, count);
  if (uploaderOff === null) {
    uploaderOff = onChatSettled((sessionId, turns) => {
      void uploadSettledChat(place, sessionId, turns);
    });
  }
  return () => {
    const next = (uploaderScopes.get(place.chatScope) ?? 1) - 1;
    if (next <= 0) {
      uploaderScopes.delete(place.chatScope);
      if (uploaderScopes.size === 0) {
        uploaderOff?.();
        uploaderOff = null;
      }
    } else {
      uploaderScopes.set(place.chatScope, next);
    }
  };
}

/** Deletes a server session this device holds no local chat for. */
export async function deleteServerSession(
  place: ChatPlace,
  serverSessionId: string
): Promise<boolean> {
  const client = syncClientFor(organizationIdOf(place.org));
  const result = await client.deleteSession(serverSessionId);
  return result.type === 'deleted' || result.type === 'not_found';
}

const backfills = new Set<string>();

/**
 * Uploads the chats that existed before this device started syncing: in the
 * background, one at a time, re-reading the setting before every request so
 * turning sync off stops it. A second ask for the same scope joins the run
 * that is already going instead of starting a parallel one.
 */
async function loadTurns(place: ChatPlace, sessionId: string): Promise<readonly Turn[]> {
  try {
    const database = await encryptedDatabase();
    const runtime = runtimeFor(place, database);
    return await runtime.runPromise(
      Effect.gen(function* loading() {
        const store = yield* SessionStore;
        const held = yield* store.load(sessionId);
        return [...held] as readonly Turn[];
      }) as Effect.Effect<readonly Turn[], unknown>
    );
  } catch {
    return [];
  }
}

export async function startBackfill(place: ChatPlace): Promise<void> {
  if (backfills.has(place.chatScope)) {
    return;
  }
  backfills.add(place.chatScope);
  try {
    const database = await encryptedDatabase();
    const db = database as unknown as ChatDatabase;
    for (;;) {
      const pending = unsyncedChatIdsOfScope(db, place.chatScope);
      if (pending.length === 0) {
        return;
      }
      const outcome = await runBackfill({
        pending: () => pending,
        upload: async sessionId => uploadNow(place, sessionId, await loadTurns(place, sessionId)),
        stillOn: () => syncSettingOn(place),
        wait: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
      });
      if (outcome.kind !== 'parked') {
        return;
      }
      // Parked: try the rest of the queue later rather than now.
      await new Promise<void>(resolve => setTimeout(resolve, 60_000));
    }
  } catch {
    // The next app foreground or exchange asks again.
  } finally {
    backfills.delete(place.chatScope);
  }
}
