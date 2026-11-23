import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import  { type NativeSyncPacket, type PulledSnapshot } from '@kilocode/cloud-agent-sdk';
import  { type Turn } from '@kilocode/harness-sdk';
import { monotonicFactory } from 'ulid';
import { beforeEach, describe, expect, it } from 'vitest';

import { type ChatDatabase, moveChat, rememberChat } from '../store';
import {
  base64ToBytes,
  type SyncCommitResult,
  type SyncDeps,
  type SyncPullResult,
  type SyncRegisterResult,
  type SyncTransport,
  uploadChat,
} from './sync-engine';
import { admitTurn, discardDiverged, pullChat } from './sync-pull';
import { syncRecordOf } from './sync-store';

const CHATS = [
  '0001_safe_hellfire_club.sql',
  '0002_majestic_old_lace.sql',
  '0003_quick_chat_titles.sql',
  '0004_dark_speedball.sql',
]
  .map(file => readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('--> statement-breakpoint');

const nextId = monotonicFactory();
const turn = (role: Turn['role'], body: string): Turn => ({
  id: `trn_${nextId()}`,
  sessionId: 'ses_local',
  role,
  parts: [{ id: `prt_${nextId()}`, kind: 'text', body }],
});

let database: DatabaseSync;
let db: ChatDatabase;
let commits: NativeSyncPacket[];
let imported: Turn[];
let forgotten: string[];
let batch = 0;

function makeDeps(
  script: {
    register?: SyncRegisterResult;
    commits?: SyncCommitResult[];
    pulls?: SyncPullResult[];
  } = {}
): SyncDeps {
  const commitQueue = [...(script.commits ?? [])];
  const pullQueue = [...(script.pulls ?? [])];
  return {
    db,
    transport: {
      register: async () => script.register ?? { type: 'registered', position: 0 },
      putBlob: async (_id, bytes) => ({ hash: 'hash', bytes: bytes.length }),
      commit: async (_id, packet) => {
        commits.push(packet);
        return (
          commitQueue.shift() ?? {
            type: 'committed',
            receipt: { through: packet.through, batchID: packet.batchID, digest: 'digest' },
          }
        );
      },
      pull: async () => pullQueue.shift() ?? { type: 'not_found' },
    },
    importTurns: async ({ turns }) => {
      imported.push(...turns);
    },
    forgetLocal: async sessionId => {
      forgotten.push(sessionId);
    },
    newBatchId: () => `batch-${(batch += 1)}`,
    newServerSessionId: () => 'ses_000000000001abcdefghijklmn',
    now: () => 1_700_000_000_000,
  };
}

const uploadInput = (turns: readonly Turn[]) => ({
  sessionId: 'ses_local',
  sourceId: 'source-mobile',
  turns,
  title: 'Chat',
  model: { providerID: 'kilo', id: 'kilo/test' },
  modelId: 'kilo/test',
  agent: 'kilo',
  createdAt: 1000,
});

const pulledSnapshot = (over: Partial<PulledSnapshot> = {}): PulledSnapshot => ({
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
});

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  for (const statement of CHATS.split('--> statement-breakpoint')) {
    database.exec(statement);
  }
  db = {
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
  rememberChat(db, { sessionId: 'ses_local', scope: 'user:personal', at: 1000 });
  commits = [];
  imported = [];
  forgotten = [];
  batch = 0;
});

describe('uploadChat', () => {
  it('registers, freezes one packet and acks it (local → pending → synced)', async () => {
    const deps = makeDeps();
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi'), turn('assistant', 'yo')]));
    expect(outcome.kind).toBe('synced');
    expect(commits).toHaveLength(1);
    expect(commits[0]?.after).toBe(0);
    expect(commits[0]?.through).toBe(commits[0]?.changes.length);
    const record = syncRecordOf(db, 'ses_local');
    expect(record).toMatchObject({
      serverSessionId: 'ses_000000000001abcdefghijklmn',
      phase: 'synced',
      outbox: null,
      ackBatch: 'batch-1',
    });
    expect(record?.ackedSeq).toBe(3); // user, assistant, idle
    expect(Object.keys(record?.messageMap ?? {})).toHaveLength(2);
  });

  it('keeps the frozen outbox on a retryable failure and resends it byte-identically', async () => {
    const deps = makeDeps({ commits: [{ type: 'retryable' }] });
    const turns = [turn('user', 'hi')];
    expect((await uploadChat(deps, uploadInput(turns))).kind).toBe('pending');
    expect(syncRecordOf(db, 'ses_local')?.phase).toBe('pending');
    const frozen = syncRecordOf(db, 'ses_local')?.outbox;
    expect(frozen).not.toBeNull();
    expect((await uploadChat(deps, uploadInput(turns))).kind).toBe('synced');
    expect(commits).toHaveLength(2);
    expect(JSON.stringify(commits[1])).toBe(JSON.stringify(commits[0]));
  });

  it('fast-forwards over a pulled log when local seqs are all above it', async () => {
    const deps = makeDeps({
      commits: [
        { type: 'conflict', position: 5 },
        { type: 'committed', receipt: { through: 9, batchID: 'batch-2', digest: 'd2' } },
      ],
      pulls: [{ type: 'pulled', snapshot: pulledSnapshot({ maxSeq: 0, messages: [] }) }],
    });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('synced');
    expect(commits[1]?.after).toBe(5);
    expect(commits[1]?.batchID).not.toBe(commits[0]?.batchID);
  });

  it('parks diverged when a local seq collides with the pulled log', async () => {
    const deps = makeDeps({
      commits: [{ type: 'conflict', position: 5 }],
      pulls: [{ type: 'pulled', snapshot: pulledSnapshot() }],
    });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('diverged');
    const record = syncRecordOf(db, 'ses_local');
    expect(record?.phase).toBe('diverged');
    expect(record?.outbox).toBeNull();
    // The remote message was imported before parking.
    expect(imported.map(one => one.parts[0]?.kind)).toContain('text');
    // And a diverged chat uploads nothing more until discarded.
    expect((await uploadChat(deps, uploadInput([turn('user', 'again')]))).kind).toBe('diverged');
    expect(commits).toHaveLength(1);
  });

  it('removes the local chat when the service answers a tombstone at register', async () => {
    const deps = makeDeps({ register: { type: 'deleted' } });
    expect((await uploadChat(deps, uploadInput([turn('user', 'hi')]))).kind).toBe('deleted');
    expect(forgotten).toEqual(['ses_local']);
    expect(syncRecordOf(db, 'ses_local')?.phase).toBe('deleted');
  });

  it('removes the local chat when the tombstone lands at commit time', async () => {
    const deps = makeDeps({ commits: [{ type: 'deleted' }] });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('deleted');
    expect(forgotten).toEqual(['ses_local']);
  });

  it('surfaces a non-retryable failure and keeps the outbox pending', async () => {
    const deps = makeDeps({ commits: [{ type: 'failed', code: 'packet_too_large' }] });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome).toEqual({ kind: 'failed', code: 'packet_too_large' });
    expect(syncRecordOf(db, 'ses_local')?.phase).toBe('pending');
  });

  it('answers unknown-chat for a session with no row', async () => {
    const deps = makeDeps();
    const outcome = await uploadChat(deps, { ...uploadInput([]), sessionId: 'ses_missing' });
    expect(outcome.kind).toBe('unknown-chat');
  });
});

describe('pullChat and admitTurn', () => {
  it('imports new messages once, then reads current', async () => {
    const deps = makeDeps({
      pulls: [
        { type: 'pulled', snapshot: pulledSnapshot() },
        { type: 'pulled', snapshot: pulledSnapshot() },
      ],
    });
    await uploadChat(deps, uploadInput([]));
    const first = await pullChat(deps, {
      sessionId: 'ses_local',
      sourceId: 'source-mobile',
      modelId: 'kilo/test',
    });
    expect(first.kind).toBe('imported');
    expect(imported).toHaveLength(1);
    const second = await pullChat(deps, {
      sessionId: 'ses_local',
      sourceId: 'source-mobile',
      modelId: 'kilo/test',
    });
    expect(second.kind).toBe('current');
    expect(syncRecordOf(db, 'ses_local')?.acknowledged).toBe(5);
  });

  it('admits a local turn only from a settled tail', async () => {
    const busy = pulledSnapshot({
      messages: [
        {
          seq: 7,
          sourceID: 'source-cli',
          message: {
            id: 'msg_busy',
            type: 'assistant',
            content: [],
            agent: 'kilo',
            model: { id: 'm', providerID: 'kilo' },
            time: { created: 1_700_000_000_000 - 1000 },
          },
        },
      ],
    });
    const deps = makeDeps({
      pulls: [
        { type: 'pulled', snapshot: busy },
        { type: 'pulled', snapshot: busy },
      ],
    });
    await uploadChat(deps, uploadInput([]));
    const admission = await admitTurn(deps, {
      sessionId: 'ses_local',
      sourceId: 'source-mobile',
      modelId: 'kilo/test',
      liveElsewhere: false,
    });
    expect(admission.kind).toBe('busy');
  });

  it('routes to the live runner when one is present, and blocks when diverged', async () => {
    const deps = makeDeps({ pulls: [{ type: 'pulled', snapshot: pulledSnapshot() }] });
    await uploadChat(deps, uploadInput([]));
    const live = await admitTurn(deps, {
      sessionId: 'ses_local',
      sourceId: 'source-mobile',
      modelId: 'kilo/test',
      liveElsewhere: true,
    });
    expect(live.kind).toBe('live-elsewhere');
  });
});

describe('discardDiverged', () => {
  it('drops the unacknowledged tail, restores its text and reloads', async () => {
    const deps = makeDeps({
      commits: [{ type: 'conflict', position: 5 }],
      pulls: [
        { type: 'pulled', snapshot: pulledSnapshot() },
        { type: 'pulled', snapshot: pulledSnapshot() },
      ],
    });
    const mine = turn('user', 'my own words');
    await uploadChat(deps, uploadInput([mine]));
    expect(syncRecordOf(db, 'ses_local')?.phase).toBe('diverged');
    const outcome = await discardDiverged(deps, {
      sessionId: 'ses_local',
      sourceId: 'source-mobile',
      modelId: 'kilo/test',
      turns: [mine],
    });
    expect(outcome).toMatchObject({ kind: 'discarded', restoredText: 'my own words' });
    expect(syncRecordOf(db, 'ses_local')?.phase).toBe('synced');
  });
});

describe('moveChat keeps the server id', () => {
  it('carries server_session_id across a harness clone', async () => {
    const deps = makeDeps();
    await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    moveChat(db, { from: 'ses_local', to: 'ses_clone', at: 2000 });
    expect(syncRecordOf(db, 'ses_clone')?.serverSessionId).toBe('ses_000000000001abcdefghijklmn');
    expect(syncRecordOf(db, 'ses_local')).toBeNull();
  });
});

describe('base64ToBytes', () => {
  it('decodes padded and unpadded input', () => {
    expect([...base64ToBytes('aGk=')]).toEqual([104, 105]);
    expect([...base64ToBytes('aGVsbG8=')]).toEqual([104, 101, 108, 108, 111]);
  });
});
