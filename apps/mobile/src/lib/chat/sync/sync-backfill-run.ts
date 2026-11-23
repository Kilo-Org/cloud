import { Effect } from 'effect';
import { SessionStore, type Turn } from '@kilocode/harness-sdk';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { type ChatPlace } from '../scope';
import { runBackfill } from './sync-backfill';
import { chatDbOf, runtimeFor } from './sync-deps';
import { syncSettingOn, uploadNow } from './sync-service';
import { unsyncedChatIdsOfScope } from './sync-store';

/**
 * The background pass over chats that predate sync. Each round asks the store
 * which chats have no server copy yet and hands them to the backfill runner.
 */

const backfills = new Set<string>();

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

/** Resolves after `ms`, so a parked round waits without blocking its caller. */
function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function backfillRound(place: ChatPlace): Promise<void> {
  const database = await encryptedDatabase();
  const db = chatDbOf(database);
  const pending = unsyncedChatIdsOfScope(db, place.chatScope);
  if (pending.length === 0) {
    return;
  }
  const outcome = await runBackfill({
    pending: () => pending,
    upload: async sessionId => uploadNow(place, sessionId, await loadTurns(place, sessionId)),
    stillOn: () => syncSettingOn(place),
    wait: delay,
  });
  if (outcome.kind !== 'parked') {
    return;
  }
  await delay(60_000);
  return backfillRound(place);
}

/**
 * Uploads the chats that existed before this device started syncing: in the
 * background, one at a time, re-reading the setting before every request so
 * turning sync off stops it. A second ask for the same scope joins the run
 * that is already going instead of starting a parallel one.
 */
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
