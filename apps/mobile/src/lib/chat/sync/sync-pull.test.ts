import { beforeEach, describe, expect, it } from 'vitest';

import { uploadChat } from './sync-engine';
import { admitTurn, discardDiverged, pullChat } from './sync-pull';
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
 * Pulling a synced chat: import what arrived once, admit a turn only from a
 * settled tail, and discard a divergent local tail back to the server log.
 */

let state: SyncTestState = createSyncState();

beforeEach(() => {
  state = createSyncState();
});

const pullInput = {
  sessionId: LOCAL_SESSION_ID,
  sourceId: 'source-mobile',
  modelId: 'kilo/test',
};

const admitInput = { ...pullInput, liveElsewhere: false };

describe('pullChat and admitTurn', () => {
  it('imports new messages once, then reads current', async () => {
    const deps = makeDeps(state, {
      pulls: [
        { type: 'pulled', snapshot: pulledSnapshot() },
        { type: 'pulled', snapshot: pulledSnapshot() },
      ],
    });
    await uploadChat(deps, uploadInput([]));
    const first = await pullChat(deps, pullInput);
    expect(first.kind).toBe('imported');
    expect(state.imported).toHaveLength(1);
    const second = await pullChat(deps, pullInput);
    expect(second.kind).toBe('current');
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.acknowledged).toBe(5);
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
    const deps = makeDeps(state, {
      pulls: [
        { type: 'pulled', snapshot: busy },
        { type: 'pulled', snapshot: busy },
      ],
    });
    await uploadChat(deps, uploadInput([]));
    const admission = await admitTurn(deps, admitInput);
    expect(admission.kind).toBe('busy');
  });

  it('routes to the live runner when one is present, and blocks when diverged', async () => {
    const deps = makeDeps(state, { pulls: [{ type: 'pulled', snapshot: pulledSnapshot() }] });
    await uploadChat(deps, uploadInput([]));
    const live = await admitTurn(deps, { ...admitInput, liveElsewhere: true });
    expect(live.kind).toBe('live-elsewhere');
  });
});

describe('discardDiverged', () => {
  it('drops the unacknowledged tail, restores its text and reloads', async () => {
    const deps = makeDeps(state, {
      commits: [{ type: 'conflict', position: 5 }],
      pulls: [
        { type: 'pulled', snapshot: pulledSnapshot() },
        { type: 'pulled', snapshot: pulledSnapshot() },
      ],
    });
    const mine = turn('user', 'my own words');
    await uploadChat(deps, uploadInput([mine]));
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.phase).toBe('diverged');
    const outcome = await discardDiverged(deps, { ...pullInput, turns: [mine] });
    expect(outcome).toMatchObject({ kind: 'discarded', restoredText: 'my own words' });
    expect(syncRecordOf(state.db, LOCAL_SESSION_ID)?.phase).toBe('synced');
  });
});
