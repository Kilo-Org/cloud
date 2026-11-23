import { randomUUID } from 'expo-crypto';
import * as Crypto from 'expo-crypto';
import { Effect, ManagedRuntime, Option } from 'effect';
import { SessionStore } from '@kilocode/harness-sdk';
import type { SQLiteDatabase } from 'expo-sqlite';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { chatLayers, organizationIdOf } from '../layers';
import { releaseChat, SYSTEM } from '../registry';
import type { ChatPlace } from '../scope';
import { type ChatDatabase, deleteChat } from '../store';
import { announceDeleted, setBanner } from './sync-banners';
import { type SyncClient, syncClientFor } from './sync-client';
import type { SyncDeps } from './sync-protocol';
import { mintServerSessionId } from './sync-ids';
import { readChatSyncSetting } from './sync-settings';

/**
 * The engine's real dependencies: this device's database, its harness store
 * and the signed-in account's transport. One runtime per account scope.
 */

const runtimes = new Map<string, ManagedRuntime.ManagedRuntime<unknown, unknown>>();

export function runtimeFor(place: ChatPlace, db: SQLiteDatabase) {
  const held = runtimes.get(place.chatScope);
  if (held !== undefined) {
    return held;
  }
  const made = ManagedRuntime.make(chatLayers(db, place.org));
  const heldRuntime = made as ManagedRuntime.ManagedRuntime<unknown, unknown>;
  runtimes.set(place.chatScope, heldRuntime);
  return heldRuntime;
}

export /** The app's database, read through the sync engine's narrower contract. */
function chatDbOf(database: SQLiteDatabase): ChatDatabase {
  return {
    getAllSync: database.getAllSync.bind(database),
    runSync: database.runSync.bind(database),
    withTransactionSync: database.withTransactionSync.bind(database),
    isInTransactionSync: database.isInTransactionSync.bind(database),
  };
}

export async function depsFor(place: ChatPlace): Promise<{ deps: SyncDeps; client: SyncClient; db: ChatDatabase }> {
  const database = await encryptedDatabase();
  const db = chatDbOf(database);
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

