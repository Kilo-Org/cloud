import { beforeEach, describe, expect, it } from 'vitest';

import { moveChat } from '../store';
import { base64ToBytes, uploadChat } from './sync-engine';
import { syncRecordOf } from './sync-store';
import {
  createSyncState,
  LOCAL_SESSION_ID,
  makeDeps,
  pulledSnapshot,
  type SyncTestState,
  turn,
  uploadInput,
} from './sync-test-helpers';

/**
 * Uploading a chat: register, freeze one packet, commit it, and the four
 * answers a commit can give. The database and the transport are the fixtures
 * in `sync-test-helpers`.
 */

let state: SyncTestState = createSyncState();

beforeEach(() => {
  state = createSyncState();
});

describe('uploadChat', () => {
  it('registers, freezes one packet and acks it (local → pending → synced)', async () => {
    const deps = makeDeps(state);
    const outcome = await uploadChat(
      deps,
      uploadInput([turn('user', 'hi'), turn('assistant', 'yo')])
    );
    expect(outcome.kind).toBe('synced');
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]?.after).toBe(0);
    expect(state.commits[0]?.through).toBe(state.commits[0]?.changes.length);
    const record = syncRecordOf(state.db, LOCAL_SESSION_ID);
    expect(record).toMatchObject({
      serverSessionId: 'ses_000000000001abcdefghijklmn',
      phase: 'synced',
      outbox: null,
      ackBatch: 'batch-1',
    });
    // User, assistant, and the idle marker that settles the tail.
    expect(record?.ackedSeq).toBe(3);
    expect(Object.keys(record?.messageMap ?? {})).toHaveLength(2);
  });

  it('keeps the frozen outbox on a retryable failure and resends it byte-identically', async () => {
    const deps = makeDeps(state, { commits: [{ type: 'retryable' }] });
    const turns = [turn('user', 'hi')];
    const first = await uploadChat(deps, uploadInput(turns));
    expect(first.kind).toBe('pending');
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.phase).toBe('pending');
    const frozen = syncRecordOf(state.db, LOCAL_SESSION_ID)?.outbox;
    expect(frozen).not.toBeNull();
    const second = await uploadChat(deps, uploadInput(turns));
    expect(second.kind).toBe('synced');
    expect(state.commits).toHaveLength(2);
    expect(JSON.stringify(state.commits[1])).toBe(JSON.stringify(state.commits[0]));
  });

  it('fast-forwards over a pulled log when local seqs are all above it', async () => {
    const deps = makeDeps(state, {
      commits: [
        { type: 'conflict', position: 5 },
        { type: 'committed', receipt: { through: 9, batchID: 'batch-2', digest: 'd2' } },
      ],
      pulls: [{ type: 'pulled', snapshot: pulledSnapshot({ maxSeq: 0, messages: [] }) }],
    });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('synced');
    expect(state.commits[1]?.after).toBe(5);
    expect(state.commits[1]?.batchID).not.toBe(state.commits[0]?.batchID);
  });

  it('parks diverged when a local seq collides with the pulled log', async () => {
    const deps = makeDeps(state, {
      commits: [{ type: 'conflict', position: 5 }],
      pulls: [{ type: 'pulled', snapshot: pulledSnapshot() }],
    });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('diverged');
    const record = syncRecordOf(state.db, LOCAL_SESSION_ID);
    expect(record?.phase).toBe('diverged');
    expect(record?.outbox).toBeNull();
    // The remote message was imported before parking.
    expect(state.imported.map(one => one.parts[0]?.kind)).toContain('text');
    // And a diverged chat uploads nothing more until discarded.
    const again = await uploadChat(deps, uploadInput([turn('user', 'again')]));
    expect(again.kind).toBe('diverged');
    expect(state.commits).toHaveLength(1);
  });

  it('removes the local chat when the service answers a tombstone at register', async () => {
    const deps = makeDeps(state, { register: { type: 'deleted' } });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('deleted');
    expect(state.forgotten).toEqual([LOCAL_SESSION_ID]);
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.phase).toBe('deleted');
  });

  it('removes the local chat when the tombstone lands at commit time', async () => {
    const deps = makeDeps(state, { commits: [{ type: 'deleted' }] });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome.kind).toBe('deleted');
    expect(state.forgotten).toEqual([LOCAL_SESSION_ID]);
  });

  it('surfaces a non-retryable failure and keeps the outbox pending', async () => {
    const deps = makeDeps(state, { commits: [{ type: 'failed', code: 'packet_too_large' }] });
    const outcome = await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    expect(outcome).toEqual({ kind: 'failed', code: 'packet_too_large' });
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.phase).toBe('pending');
  });

  it('answers unknown-chat for a session with no row', async () => {
    const deps = makeDeps(state);
    const outcome = await uploadChat(deps, { ...uploadInput([]), sessionId: 'ses_missing' });
    expect(outcome.kind).toBe('unknown-chat');
  });
});

describe('moveChat keeps the server id', () => {
  it('carries server_session_id across a harness clone', async () => {
    const deps = makeDeps(state);
    await uploadChat(deps, uploadInput([turn('user', 'hi')]));
    moveChat(state.db, { from: LOCAL_SESSION_ID, to: 'ses_clone', at: 2000 });
    expect(syncRecordOf(state.db, 'ses_clone')?.serverSessionId).toBe(
      'ses_000000000001abcdefghijklmn'
    );
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)).toBeNull();
  });
});

describe('base64ToBytes', () => {
  it('decodes padded and unpadded input', () => {
    expect([...base64ToBytes('aGk=')]).toEqual([104, 105]);
    expect([...base64ToBytes('aGVsbG8=')]).toEqual([104, 101, 108, 108, 111]);
  });
});
