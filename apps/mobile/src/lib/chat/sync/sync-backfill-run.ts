import { Effect } from 'effect';
import { SessionStore, type Turn } from '@kilocode/harness-sdk';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import type { ChatPlace } from '../scope';
import type { ChatDatabase } from '../store';
import { runBackfill } from './sync-backfill';
import { runtimeFor } from './sync-deps';
import { syncSettingOn, uploadNow } from './sync-service';
import { unsyncedChatIdsOfScope } from './sync-store';

/**
 * The background pass over chats that predate sync. Each round asks the store
 * which chats have no server copy yet and hands them to the backfill runner.
 */

const backfills = new Set<string>();

/**
 * Uploads the chats that existed before this device started syncing: in the
 * background, one at a time, re-reading the setting before every request so
 * turning sync off stops it. A second ask for the same scope joins the run
 * that is already going instead of starting a parallel one.
 */
/** The turns a background upload would send for one chat. */
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

async function backfillRound(place: ChatPlace): Promise<void> {
  const database = await encryptedDatabase();
  const db = database as unknown as ChatDatabase;
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
  await new Promise<void>(resolve => setTimeout(resolve, 60_000));
  return backfillRound(place);
}

export async function startBackfill(place: ChatPlace): Promise<void> {
  if (backfills.has(place.chatScope)) {
    return;
  }
  backfills.add(place.chatScope);
  try {
    await backfillRound(place);
  } catch {
    // The next app foreground or exchange asks again.
  } finally {
    backfills.delete(place.chatScope);
  }
}
