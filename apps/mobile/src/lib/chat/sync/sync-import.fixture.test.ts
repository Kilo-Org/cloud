import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { type PulledSnapshot } from '@kilocode/cloud-agent-sdk';
import { SessionStore } from '@kilocode/harness-sdk';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';
import { Effect, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { rememberChat } from '../store';
import { pullChat } from './sync-pull';
import { stampServerSessionId, syncRecordOf } from './sync-store';
import { type SyncDeps } from './sync-protocol';

/**
 * The real CLI-origin payload the device run captured (ses_df7025c6dffe…):
 * instruction blobs, tool-less text turns, idle markers between exchanges.
 * Importing it through the real harness store is what the app failed to do.
 */

const fixtureSchema = z.object({
  type: z.literal('pulled'),
  snapshot: z.custom<PulledSnapshot>(),
});
const snapshot = fixtureSchema.parse(
  JSON.parse(readFileSync(new URL('fixtures/cli-session-snapshot.json', import.meta.url), 'utf8'))
).snapshot;

const CHATS = [
  '0001_safe_hellfire_club.sql',
  '0002_majestic_old_lace.sql',
  '0003_quick_chat_titles.sql',
  '0004_dark_speedball.sql',
]
  .map(file => readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('--> statement-breakpoint');

const SESSION_ID = 'ses_df7025c6dffeICl18lhZYa7mH8';

/** One import run against the real harness store, with the fixture snapshot. */
async function importWith(options: {
  readonly model?: { readonly providerID: string; readonly id: string } | undefined;
  readonly callerModel: string;
}) {
  const database = new DatabaseSync(':memory:');
  for (const statement of CHATS.split('--> statement-breakpoint')) {
    database.exec(statement);
  }
  const db = {
    getAllSync: <T>(source: string, params: (string | number)[]) =>
      database.prepare(source).all(...params) as T[],
    runSync: (source: string, params: (string | number)[]) => {
      database.prepare(source).run(...params);
    },
    withTransactionSync: (work: () => void) => {
      database.exec('begin');
      try {
        work();
        database.exec('commit');
      } catch (error) {
        database.exec('rollback');
        throw error;
      }
    },
    isInTransactionSync: () => database.isTransaction,
  };
  rememberChat(db, { sessionId: SESSION_ID, scope: 'user:personal', at: 1000 });
  stampServerSessionId({ db, sessionId: SESSION_ID, serverSessionId: SESSION_ID, sourceId: 'src' });
  const run = <A>(work: Effect.Effect<A, unknown, SessionStore>): Promise<A> =>
    Effect.runPromise(
      Effect.provide(work, layerNodeStore(database)) as unknown as Effect.Effect<A>
    );
  const chosen = options.model;
  // The snapshot type carries an index signature on `origin`; the spread keeps
  // every field the reader validated, so one assertion states that contract.
  const payload = (
    chosen === undefined || snapshot.session === null
      ? snapshot
      : {
          ...snapshot,
          session: { ...snapshot.session, model: { id: chosen.id, providerID: chosen.providerID } },
        }
  ) as PulledSnapshot;
  const deps: SyncDeps = {
    db,
    transport: {
      register: () => Promise.resolve({ type: 'registered', position: 51 }),
      putBlob: () => Promise.resolve({ hash: 'h', bytes: 0 }),
      commit: () => Promise.resolve({ type: 'retryable' }),
      pull: () => Promise.resolve({ type: 'pulled', snapshot: payload }),
    },
    importTurns: ({ sessionId, turns, model }) =>
      run(
        Effect.gen(function* importing() {
          const store = yield* SessionStore;
          const held = yield* store.read(sessionId);
          if (Option.isNone(held)) {
            yield* store.create({ id: sessionId, system: 'mobile system', model });
          }
          yield* store.append({
            sessionId,
            turns: [...turns],
            prompted: Option.isSome(held) ? (held.value.prompted ?? 0) : 0,
          });
          yield* store.flush();
        })
      ),
    forgetLocal: () => Promise.resolve(),
    newBatchId: () => 'b1',
    newServerSessionId: () => SESSION_ID,
    now: () => 1000,
  };
  const outcome = await pullChat(deps, {
    sessionId: SESSION_ID,
    sourceId: 'src',
    modelId: options.callerModel,
  });
  const loaded = await run(
    Effect.gen(function* reading() {
      const store = yield* SessionStore;
      const held = yield* store.read(SESSION_ID);
      const turns = yield* store.load(SESSION_ID);
      return { held, turns };
    })
  );
  return { outcome, loaded, db };
}

describe('importing the captured CLI session', () => {
  it('becomes harness turns that the store hands back in order', async () => {
    const { outcome, loaded, db } = await importWith({ callerModel: 'kilo/test' });
    expect(outcome.kind).toBe('imported');
    expect(Option.isSome(loaded.held)).toBe(true);
    expect(loaded.turns.map(turn => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(loaded.turns[0]?.parts[0]).toMatchObject({ kind: 'text' });
    expect(syncRecordOf(db, SESSION_ID)).toMatchObject({ phase: 'synced', acknowledged: 51 });
  });

  it('keeps a gateway model this app wrote, so the chat opens continuable', async () => {
    const { loaded } = await importWith({
      model: { providerID: 'kilo', id: 'fake-deterministic' },
      callerModel: '',
    });
    const held = Option.getOrUndefined(loaded.held);
    expect(held?.model).toBe('fake-deterministic');
  });

  it('uses the app default for a model only the other side can route', async () => {
    const { loaded } = await importWith({
      model: { providerID: 'anthropic', id: 'claude-x' },
      callerModel: 'fake-deterministic',
    });
    expect(Option.getOrUndefined(loaded.held)?.model).toBe('fake-deterministic');
  });

  it('imports nothing when no model can be routed at all', async () => {
    const { outcome, loaded } = await importWith({
      model: { providerID: 'anthropic', id: 'claude-x' },
      callerModel: '',
    });
    expect(outcome).toEqual({ kind: 'current' });
    expect(Option.isNone(loaded.held)).toBe(true);
  });
});
