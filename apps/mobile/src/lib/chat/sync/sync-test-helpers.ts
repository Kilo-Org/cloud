import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { type NativeSyncPacket, type PulledSnapshot } from '@kilocode/cloud-agent-sdk';
import { type Turn } from '@kilocode/harness-sdk';
import { monotonicFactory } from 'ulid';

import { type ChatDatabase, rememberChat } from '../store';
import {
  type SyncCommitResult,
  type SyncDeps,
  type SyncPullResult,
  type SyncRegisterResult,
} from './sync-engine';

/**
 * The sync suites' fixtures: a real SQLite database built from the app's
 * migrations, a transport that records what the engine sent, and the harness
 * store replaced by two lists. Everything below the engine is real SQL.
 */

const CHATS = [
  '0001_safe_hellfire_club.sql',
  '0002_majestic_old_lace.sql',
  '0003_quick_chat_titles.sql',
  '0004_dark_speedball.sql',
]
  .map(file => readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('--> statement-breakpoint');

const nextId = monotonicFactory();

/** The local session every suite uploads, seeded with one row per state. */
export const LOCAL_SESSION_ID = 'ses_local';

/** Real SQL behind the engine's narrow database contract. */
function chatDatabase(database: DatabaseSync): ChatDatabase {
  return {
    getAllSync: <T>(source: string, params: (string | number)[]) =>
      database.prepare(source).all(...params) as T[],
    runSync: (source: string, params: (string | number)[]) => {
      database.prepare(source).run(...params);
    },
    withTransactionSync: work => {
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
}

/** One suite's database, plus what the fake transport recorded. */
export type SyncTestState = {
  readonly database: DatabaseSync;
  readonly db: ChatDatabase;
  readonly commits: NativeSyncPacket[];
  readonly imported: Turn[];
  readonly forgotten: string[];
  batch: number;
};

/** A fresh in-memory database with the local chat already remembered. */
export function createSyncState(): SyncTestState {
  const database = new DatabaseSync(':memory:');
  for (const statement of CHATS.split('--> statement-breakpoint')) {
    database.exec(statement);
  }
  const db = chatDatabase(database);
  rememberChat(db, { sessionId: LOCAL_SESSION_ID, scope: 'user:personal', at: 1000 });
  return { database, db, commits: [], imported: [], forgotten: [], batch: 0 };
}

/** A turn with one text part, under a fresh id. */
export function turn(role: Turn['role'], body: string): Turn {
  return {
    id: `trn_${nextId()}`,
    sessionId: LOCAL_SESSION_ID,
    role,
    parts: [{ id: `prt_${nextId()}`, kind: 'text', body }],
  };
}

/** The input one upload of these turns takes. */
export function uploadInput(turns: readonly Turn[]) {
  return {
    sessionId: LOCAL_SESSION_ID,
    sourceId: 'source-mobile',
    turns,
    title: 'Chat',
    model: { providerID: 'kilo', id: 'kilo/test' },
    modelId: 'kilo/test',
    agent: 'kilo',
    createdAt: 1000,
  };
}

/** A pulled log with one user message from the CLI, unless overridden. */
export function pulledSnapshot(over: Partial<PulledSnapshot> = {}): PulledSnapshot {
  return {
    position: 5,
    revision: 2,
    lastReceipt: null,
    sources: [],
    session: null,
    messages: [
      {
        seq: 7,
        sourceID: 'source-cli',
        message: { id: 'msg_cli1', type: 'user', text: 'from cli', time: { created: 2000 } },
      },
    ],
    maxSeq: 7,
    ...over,
  };
}

/** What one suite's transport answers, by call. */
export type SyncScript = {
  register?: SyncRegisterResult;
  commits?: SyncCommitResult[];
  pulls?: SyncPullResult[];
};

/** The engine's dependencies over `state`, with the scripted transport answers. */
export function makeDeps(state: SyncTestState, script: SyncScript = {}): SyncDeps {
  const commitQueue = [...(script.commits ?? [])];
  const pullQueue = [...(script.pulls ?? [])];
  return {
    db: state.db,
    transport: {
      register: () => Promise.resolve(script.register ?? { type: 'registered', position: 0 }),
      putBlob: (_id, bytes) => Promise.resolve({ hash: 'hash', bytes: bytes.length }),
      commit: (_id, packet) => {
        state.commits.push(packet);
        return Promise.resolve(
          commitQueue.shift() ?? {
            type: 'committed',
            receipt: { through: packet.through, batchID: packet.batchID, digest: 'digest' },
          }
        );
      },
      pull: () => Promise.resolve(pullQueue.shift() ?? { type: 'not_found' }),
    },
    importTurns: ({ turns }) => {
      state.imported.push(...turns);
      return Promise.resolve();
    },
    forgetLocal: sessionId => {
      state.forgotten.push(sessionId);
      return Promise.resolve();
    },
    newBatchId: () => `batch-${(state.batch += 1)}`,
    newServerSessionId: () => 'ses_000000000001abcdefghijklmn',
    now: () => 1_700_000_000_000,
  };
}
