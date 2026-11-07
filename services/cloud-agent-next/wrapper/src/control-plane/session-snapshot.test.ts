import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient } from '../kilo-api.js';
import { readSessionSnapshot } from './session-snapshot.js';
import { kiloActivityReads } from './kilo-message-activity.js';
import type { ActivitySnapshotMessage } from './harness-activity.js';

function fixture() {
  const readDirectories: string[] = [];
  const messageReads: string[] = [];
  const client = {
    listSessionMetadata: async () => [
      { id: 'root', directory: '/one' },
      { id: 'child', directory: '/two', parentID: 'root' },
    ],
    getSessionStatuses: async (directory: string) => {
      readDirectories.push(directory);
      return directory === '/two' ? { child: { type: 'busy' } } : {};
    },
    getQuestions: async () => [],
    getPermissions: async () => [],
    getSuggestions: async () => [],
    getRecentSessionMessages: async () => [
      {
        info: { id: 'msg', sessionID: 'child', role: 'assistant', time: { created: 1 } },
        parts: [],
      },
    ],
    getSessionMessage: async (_sessionId: string, _directory: string, messageId: string) => {
      messageReads.push(messageId);
      return {
        info: { id: messageId, sessionID: 'child', role: 'assistant', time: { created: 1 } },
        parts: [
          {
            id: 'tool',
            messageID: messageId,
            sessionID: 'child',
            type: 'tool',
            callID: 'call',
            tool: 'bash',
            state: { status: 'running' },
          },
        ],
      };
    },
  } as unknown as WrapperKiloClient;
  return {
    client: { ...client, ...kiloActivityReads(client) },
    readDirectories,
    messageReads,
  };
}

describe('session activity snapshots', () => {
  it('covers discovered directories, owned directories, observed execution directories and known old in-flight messages', async () => {
    const f = fixture();
    const snapshot = await readSessionSnapshot({
      client: f.client,
      directory: '/owned',
      observedDirectories: ['/feed-only'],
      knownSessions: [{ id: 'child', directory: '/two', messageIds: ['older'] }],
      signal: AbortSignal.timeout(1000),
    });
    expect(f.readDirectories.sort()).toEqual(['/feed-only', '/one', '/owned', '/two']);
    expect(f.messageReads.sort()).toEqual(['msg', 'older']);
    expect(snapshot.find(session => session.id === 'child')).toMatchObject({
      status: 'busy',
      parentID: 'root',
      directory: '/two',
    });
    expect(snapshot.find(session => session.id === 'child')?.messages).toHaveLength(2);
    expect(snapshot.find(session => session.id === 'root')?.status).toBe('idle');
  });

  it('rejects the entire snapshot if one directory fails', async () => {
    const f = fixture();
    f.client.getQuestions = async directory => {
      if (directory === '/two') throw new Error('unavailable');
      return [];
    };
    const error = await readSessionSnapshot({
      client: f.client,
      directory: '/one',
      observedDirectories: [],
      knownSessions: [],
      signal: AbortSignal.timeout(1000),
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'unavailable' });
  });

  it('hydrates pending request tool identity even when an idle status hides ongoing work', async () => {
    const f = fixture();
    f.client.getSessionStatuses = async () => ({});
    f.client.getQuestions = async directory =>
      directory === '/two'
        ? [
            {
              id: 'q1',
              sessionID: 'child',
              questions: [],
              tool: { messageID: 'blocked', callID: 'call' },
            },
          ]
        : [];
    const snapshot = await readSessionSnapshot({
      client: f.client,
      directory: '/one',
      observedDirectories: [],
      knownSessions: [],
      signal: AbortSignal.timeout(1000),
    });
    expect(f.messageReads.sort()).toEqual(['blocked', 'msg']);
    expect(snapshot.find(session => session.id === 'child')?.interactions).toEqual([
      { id: 'q1', blocking: true, callID: 'call' },
    ]);
  });

  it('re-reads known in-flight and pending request messages already present in the recent list', async () => {
    const f = fixture();
    f.client.getSessionStatuses = async directory =>
      (directory === '/two' ? { child: { type: 'busy' } } : {}) as Awaited<
        ReturnType<WrapperKiloClient['getSessionStatuses']>
      >;
    // The recent-list projection lags the per-message read: both entries exist
    // but carry no live tool state.
    const recent: ActivitySnapshotMessage[] = [
      { sessionId: 'child', id: 'inflight', role: 'assistant', time: { created: 1 }, parts: [] },
      {
        sessionId: 'child',
        id: 'pending-tool',
        role: 'assistant',
        time: { created: 1 },
        parts: [],
      },
    ];
    f.client.getRecentActivity = async () => recent;
    f.client.getQuestions = async directory =>
      directory === '/two'
        ? [
            {
              id: 'q1',
              sessionID: 'child',
              questions: [],
              tool: { messageID: 'pending-tool', callID: 'call' },
            },
          ]
        : [];
    const snapshot = await readSessionSnapshot({
      client: f.client,
      directory: '/one',
      observedDirectories: [],
      knownSessions: [{ id: 'child', directory: '/two', messageIds: ['inflight'] }],
      signal: AbortSignal.timeout(1000),
    });
    expect(f.messageReads.sort()).toEqual(['inflight', 'pending-tool']);
    const messages = snapshot.find(session => session.id === 'child')?.messages ?? [];
    expect(messages.map(message => message.id).sort()).toEqual(['inflight', 'pending-tool']);
    for (const message of messages) {
      expect(message.parts).toContainEqual(
        expect.objectContaining({
          kind: 'tool',
          tool: expect.objectContaining({ status: 'running' }),
        })
      );
    }
  });

  it('carries the message of a retry status', async () => {
    const f = fixture();
    const retry = { type: 'retry', attempt: 3, message: 'Too Many Requests', next: 5_000 };
    f.client.getSessionStatuses = async (
      directory?: string
    ): Promise<Record<string, typeof retry>> => (directory === '/two' ? { child: retry } : {});
    const snapshot = await readSessionSnapshot({
      client: f.client,
      directory: '/one',
      observedDirectories: [],
      knownSessions: [],
      signal: AbortSignal.timeout(1000),
    });
    expect(snapshot.find(session => session.id === 'child')).toMatchObject({
      status: 'retry',
      retry: { message: 'Too Many Requests' },
    });
  });

  it('never merges contradictory execution directories for the same session', async () => {
    const f = fixture();
    f.client.getSessionStatuses = async () => ({ child: { type: 'busy' } });
    const error = await readSessionSnapshot({
      client: f.client,
      directory: '/one',
      observedDirectories: [],
      knownSessions: [],
      signal: AbortSignal.timeout(1000),
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Activity snapshot received mismatched execution directory',
    });
  });
});
