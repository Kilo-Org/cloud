import { type Turn } from '@kilocode/harness-sdk';

import { organizationIdOf } from '../layers';
import { enterChat, releaseChat } from '../registry';
import { type ChatPlace } from '../scope';
import { type ChatDatabase, modelOfSession, recordOfChat, rememberChat } from '../store';
import { onChatSettled } from './sync-hooks';
import { setBanner } from './sync-banners';
import { syncClientFor } from './sync-client';
import { depsFor } from './sync-deps';
import { type UploadOutcome, uploadChat } from './sync-engine';
import { portableModelRef } from './sync-mapping';
import { discardDiverged, pullChat } from './sync-pull';
import { chatSyncSourceId, readChatSyncSetting } from './sync-settings';
import {
  saveSyncRecord,
  stampServerSessionId,
  syncRecordByServerId,
  syncRecordOf,
} from './sync-store';

export { bannerOf, onDeletedElsewhere, watchBanners, type SyncBanner } from './sync-banners';

/**
 * Wiring: the engine against the real database, harness store and SDK
 * client, plus the banner status screens read. The gate (flag and the
 * per-account setting) is answered here, once, for every caller.
 */

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
export async function uploadNow(
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

/** Whether sync runs for this place: on unless this device stored an off. */
export async function syncSettingOn(place: ChatPlace): Promise<boolean> {
  return (await readChatSyncSetting(place.chatScope)) === 'on';
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

