import type { SessionLiveActivityContentState } from '@kilocode/notifications';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverSessionCards,
  planSessionCardSend,
  type SessionCardDeliveryDeps,
  type SessionCardSend,
  type SessionCardSource,
} from './session-card-delivery';

const updatedAt = '2026-10-12T10:00:00.000Z';
const nowSeconds = Date.parse(updatedAt) / 1000;

function source(row: Partial<NonNullable<SessionCardSource['row']>>): SessionCardSource {
  return {
    sessionId: 'ses_1',
    row: {
      title: 'Fix login',
      status: 'busy',
      statusUpdatedAt: '2026-10-12T09:00:00.000Z',
      scheduledAt: null,
      approvalKey: null,
      ...row,
    },
  };
}

function plan(
  next: SessionCardSource,
  previous?: SessionLiveActivityContentState
): ReturnType<typeof planSessionCardSend> {
  return planSessionCardSend({
    token: 'card',
    sessionId: 'ses_1',
    source: next,
    previous,
    updatedAt,
    nowSeconds,
  });
}

function shown(next: SessionCardSource): SessionLiveActivityContentState {
  const planned = plan(next);
  if (planned === null) throw new Error('expected a send');
  return planned.content;
}

describe('planSessionCardSend', () => {
  it('uses priority 10 only when the card enters needs input', () => {
    expect(plan(source({ status: 'question' }))?.send).toMatchObject({
      event: 'update',
      priority: 10,
      relevanceScore: 100,
    });
    expect(
      plan(source({ status: 'question' }), shown(source({ status: 'busy' })))?.send.priority
    ).toBe(10);
    // A permission request that replaces a question keeps the needs-input kind.
    const permission = plan(
      source({ status: 'permission', approvalKey: 'b'.repeat(64) }),
      shown(source({ status: 'question' }))
    );
    expect(permission?.send).toMatchObject({ event: 'update', priority: 5 });
    expect(permission?.content).toMatchObject({ awaitingPermission: true });
  });

  it('uses priority 5 for running and scheduled updates', () => {
    expect(plan(source({ status: 'busy' }))?.send).toMatchObject({
      priority: 5,
      relevanceScore: 60,
    });
    const scheduled = plan(
      source({ status: 'scheduled', scheduledAt: '2026-10-12T12:00:00.000Z' }),
      shown(source({ status: 'busy' }))
    );
    expect(scheduled?.send.priority).toBe(5);
    expect(scheduled?.content).toMatchObject({
      statusKind: 'scheduled',
      scheduledAt: '2026-10-12T12:00:00.000Z',
    });
  });

  it('skips a push that does not change what the card shows', () => {
    const previous = { ...shown(source({ status: 'busy' })), updatedAt: '2026-10-12T09:59:00.000Z' };
    expect(plan(source({ status: 'busy' }), previous)).toBeNull();
  });

  it('keeps the shown timer when the row has no status time and the kind holds', () => {
    const previous = shown(source({ status: 'busy' }));
    expect(plan(source({ status: 'busy', statusUpdatedAt: null }), previous)).toBeNull();
    expect(plan(source({ status: 'question', statusUpdatedAt: null }), previous)?.content).toMatchObject(
      { statusSince: updatedAt }
    );
  });

  it('ends a finished session with the Finished content and a 15 minute dismissal', () => {
    const finished = plan(
      source({ status: 'idle', statusUpdatedAt: '2026-10-12T09:58:00.000Z' }),
      shown(source({ status: 'busy' }))
    );
    expect(finished?.send).toMatchObject({
      event: 'end',
      priority: 10,
      relevanceScore: 20,
      dismissalDateSeconds: nowSeconds + 15 * 60,
    });
    expect(JSON.parse(finished?.send.contentState.props ?? '{}')).toMatchObject({
      statusKind: 'idle',
      statusSince: '2026-10-12T09:58:00.000Z',
    });
    expect(finished?.send.contentState.name).toBe('SessionLiveActivity');
  });

  it('ends a deleted or out-of-scope session at once', () => {
    const previous = shown(source({ status: 'busy' }));
    const gone = plan({ sessionId: 'ses_1', row: null }, previous);
    expect(gone?.send).toMatchObject({ event: 'end', priority: 10, dismissalDateSeconds: nowSeconds });
    expect(gone?.content).toEqual(previous);
  });
});

describe('deliverSessionCards', () => {
  function harness(tokens: { token: string; sessionId: string }[]) {
    const memory = new Map<string, SessionLiveActivityContentState>();
    const sends: SessionCardSend[] = [];
    const deps: SessionCardDeliveryDeps = {
      listIosSessionActivityTokens: vi.fn(async () => tokens),
      sendIosSessionLiveActivity: vi.fn(async (send: SessionCardSend) => {
        sends.push(send);
        return send.token !== 'rejected';
      }),
      sessionCardMemory: {
        list: async () => new Map(memory),
        put: async (token, content) => {
          memory.set(token, content);
        },
        delete: async keys => {
          for (const key of keys) memory.delete(key);
        },
      },
    };
    return { deps, memory, sends };
  }

  const deliver = (
    deps: SessionCardDeliveryDeps,
    sources: readonly SessionCardSource[] | 'end_all'
  ) =>
    deliverSessionCards(
      { userId: 'u1', organizationId: null, sources, updatedAt, timestampSeconds: 7, nowSeconds },
      deps
    );

  it('remembers only accepted updates and forgets tokens that left the scope', async () => {
    const { deps, memory, sends } = harness([
      { token: 'card', sessionId: 'ses_1' },
      { token: 'rejected', sessionId: 'ses_1' },
      { token: 'unread', sessionId: 'ses_other' },
    ]);
    memory.set('gone', shown(source({})));

    await deliver(deps, [source({ status: 'busy' })]);

    // A token whose session the build did not read waits for its own refresh.
    expect(sends.map(send => send.token)).toEqual(['card', 'rejected']);
    expect([...memory.keys()]).toEqual(['card']);
    expect(deps.sendIosSessionLiveActivity).toHaveBeenCalledWith(expect.anything(), 7, undefined);

    await deliver(deps, [source({ status: 'busy' })]);
    expect(sends.map(send => send.token)).toEqual(['card', 'rejected', 'rejected']);
  });

  it('forgets a card after its end is accepted', async () => {
    const { deps, memory } = harness([{ token: 'card', sessionId: 'ses_1' }]);
    await deliver(deps, [source({ status: 'busy' })]);
    expect(memory.has('card')).toBe(true);
    await deliver(deps, [source({ status: 'idle' })]);
    expect(memory.has('card')).toBe(false);
  });

  it('ends every card when the user lost the scope', async () => {
    const { deps, sends } = harness([
      { token: 'a', sessionId: 'ses_1' },
      { token: 'b', sessionId: 'ses_2' },
    ]);
    await deliver(deps, 'end_all');
    expect(sends.map(({ token, event, dismissalDateSeconds }) => [token, event, dismissalDateSeconds])).toEqual([
      ['a', 'end', nowSeconds],
      ['b', 'end', nowSeconds],
    ]);
  });

  it('sends nothing once a newer revision owns the scope', async () => {
    const { deps, sends } = harness([{ token: 'card', sessionId: 'ses_1' }]);
    await deliver({ ...deps, isCurrent: async () => false }, [source({ status: 'busy' })]);
    expect(sends).toHaveLength(0);
  });
});
