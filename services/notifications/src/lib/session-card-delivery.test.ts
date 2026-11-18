import {
  type SessionLiveActivityContentState,
  sessionLiveActivityRelevance,
} from '@kilocode/notifications';
import { describe, expect, it, vi } from 'vitest';

import {
  androidSessionMemoryKey,
  deliverSessionCards,
  planSessionCardSend,
  SESSION_CARD_FINISHED_DISMISS_MS,
  sessionLiveUpdateExpoMessage,
  type AndroidSessionSend,
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
      relevanceScore: sessionLiveActivityRelevance('needsInput', '2026-10-12T09:00:00.000Z'),
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
      relevanceScore: sessionLiveActivityRelevance('running', '2026-10-12T09:00:00.000Z'),
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
    const previous = {
      ...shown(source({ status: 'busy' })),
      updatedAt: '2026-10-12T09:59:00.000Z',
    };
    expect(plan(source({ status: 'busy' }), previous)).toBeNull();
  });

  it('keeps the shown timer when the row has no status time and the kind holds', () => {
    const previous = shown(source({ status: 'busy' }));
    expect(plan(source({ status: 'busy', statusUpdatedAt: null }), previous)).toBeNull();
    expect(
      plan(source({ status: 'question', statusUpdatedAt: null }), previous)?.content
    ).toMatchObject({ statusSince: updatedAt });
  });

  it('ends a finished session with the Finished content and a 15 minute dismissal', () => {
    const finished = plan(
      source({ status: 'idle', statusUpdatedAt: '2026-10-12T09:58:00.000Z' }),
      shown(source({ status: 'busy' }))
    );
    expect(finished?.send).toMatchObject({
      event: 'end',
      priority: 10,
      relevanceScore: sessionLiveActivityRelevance('idle', '2026-10-12T09:58:00.000Z'),
      dismissalDateSeconds: nowSeconds + 15 * 60,
    });
    expect(JSON.parse(finished?.send.content.props ?? '{}')).toMatchObject({
      statusKind: 'idle',
      statusSince: '2026-10-12T09:58:00.000Z',
    });
    expect(finished?.send.content.name).toBe('SessionLiveActivity');
  });

  it('sends a step-only change at priority 5 with the new step and the same timer', () => {
    const previous = shown(source({ status: 'busy' }));
    const step = { verb: 'editing' as const, target: 'auth.ts' };
    const planned = plan(
      source({
        status: 'busy',
        summary: {
          step,
          plan: { done: 3, total: 7, current: 'Write tests' },
          changes: null,
          failure: null,
        },
        lastActivityAt: '2026-10-12T09:59:30.000Z',
      }),
      previous
    );
    expect(planned?.send).toMatchObject({ event: 'update', priority: 5 });
    expect(planned?.content).toMatchObject({
      currentStep: step,
      plan: { done: 3, total: 7, current: 'Write tests' },
      statusSince: previous.statusSince,
    });
    // The quiet window closes five minutes after the last activity.
    expect(planned?.send.staleAtSeconds).toBe(
      Math.floor(Date.parse('2026-10-12T09:59:30.000Z') / 1000) + 300
    );
  });

  it('keeps the aggregate stale window for a card that is not working', () => {
    const planned = plan(
      source({ status: 'question', lastActivityAt: '2026-10-12T09:59:30.000Z' })
    );
    expect(planned?.send.staleAtSeconds).toBe(nowSeconds + 30 * 60);
  });

  it('ends a failed session with the stopped content at priority 10', () => {
    const failed = plan(
      source({
        status: 'idle',
        statusUpdatedAt: '2026-10-12T09:58:00.000Z',
        summary: {
          step: null,
          plan: { done: 2, total: 5, current: null },
          changes: { files: 3, added: 12, removed: 4 },
          failure: { kind: 'provider' },
        },
      }),
      shown(source({ status: 'busy' }))
    );
    expect(failed?.send).toMatchObject({
      event: 'end',
      priority: 10,
      dismissalDateSeconds: nowSeconds + 900,
    });
    expect(JSON.parse(failed?.send.content.props ?? '{}')).toMatchObject({
      statusKind: 'failed',
      failure: { kind: 'provider' },
      outcome: { kind: 'changes' },
      changes: { files: 3, added: 12, removed: 4 },
    });
  });

  it('reads an opened pull request as the outcome of a finished session', () => {
    const finished = plan(source({ status: 'idle', prOpened: true }));
    expect(finished?.content).toMatchObject({ statusKind: 'idle', outcome: { kind: 'pr_opened' } });
  });

  it('drops the command when the permission is answered', () => {
    const waiting = plan(
      source({
        status: 'permission',
        approvalKey: 'a'.repeat(64),
        permissionCommand: 'pnpm drizzle migrate',
      })
    );
    expect(waiting?.content.permissionCommand).toBe('pnpm drizzle migrate');
    const answered = plan(source({ status: 'busy' }), waiting?.content);
    expect(answered?.content.permissionCommand).toBeNull();
  });

  it('ends a deleted or out-of-scope session at once', () => {
    const previous = shown(source({ status: 'busy' }));
    const gone = plan({ sessionId: 'ses_1', row: null }, previous);
    expect(gone?.send).toMatchObject({
      event: 'end',
      priority: 10,
      dismissalDateSeconds: nowSeconds,
    });
    // Neutral content: never the title the card showed before.
    expect(gone?.content).toEqual({
      sessionId: 'ses_1',
      title: null,
      statusKind: 'idle',
      statusSince: updatedAt,
      scheduledAt: null,
      awaitingPermission: false,
      approvalKey: null,
      updatedAt,
    });
    expect(JSON.stringify(gone?.send.content)).not.toContain('Fix login');
    expect(previous.title).toBe('Fix login');
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
    expect(
      sends.map(({ token, event, dismissalDateSeconds }) => [token, event, dismissalDateSeconds])
    ).toEqual([
      ['a', 'end', nowSeconds],
      ['b', 'end', nowSeconds],
    ]);
  });

  it('sends nothing once a newer revision owns the scope', async () => {
    const { deps, sends } = harness([{ token: 'card', sessionId: 'ses_1' }]);
    await deliver({ ...deps, isCurrent: async () => false }, [source({ status: 'busy' })]);
    expect(sends).toHaveLength(0);
  });

  function androidHarness(tokens: { token: string; sessionId: string }[]) {
    const memory = new Map<string, SessionLiveActivityContentState>();
    const sends: AndroidSessionSend[] = [];
    const deps: SessionCardDeliveryDeps = {
      listAndroidSessionTokens: vi.fn(async () => tokens),
      sendAndroidSessionLiveUpdate: vi.fn(async (send: AndroidSessionSend) => {
        sends.push(send);
        return send.token !== 'rejected';
      }),
      sessionCardMemory: {
        list: async () => new Map(memory),
        put: async (key, content) => {
          memory.set(key, content);
        },
        delete: async keys => {
          for (const key of keys) memory.delete(key);
        },
      },
    };
    return { deps, memory, sends };
  }

  it('sends one Expo data message per followed session on Android', async () => {
    const { deps, memory, sends } = androidHarness([
      { token: 'ExponentPushToken[aaa]', sessionId: 'ses_1' },
    ]);

    await deliver(deps, [source({ status: 'busy' })]);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      token: 'ExponentPushToken[aaa]',
      sessionId: 'ses_1',
      event: 'update',
    });
    expect(sends[0]?.dismissAfterMs).toBeUndefined();
    expect(memory.has(androidSessionMemoryKey('ExponentPushToken[aaa]', 'ses_1'))).toBe(true);

    // The same content again is not pushed (spec "Updates" rule 2).
    await deliver(deps, [source({ status: 'busy' })]);
    expect(sends).toHaveLength(1);
  });

  it('keeps one device token per session on Android', async () => {
    const { deps, sends } = androidHarness([
      { token: 'ExponentPushToken[aaa]', sessionId: 'ses_1' },
      { token: 'ExponentPushToken[aaa]', sessionId: 'ses_2' },
    ]);

    await deliver(deps, [
      source({ status: 'busy' }),
      { ...source({ status: 'busy' }), sessionId: 'ses_2' },
    ]);

    expect(sends.map(send => send.sessionId).sort()).toEqual(['ses_1', 'ses_2']);
  });

  it('ends an Android session after the finished window, and at once with no content', async () => {
    const { deps, sends } = androidHarness([
      { token: 'ExponentPushToken[aaa]', sessionId: 'ses_1' },
    ]);

    await deliver(deps, [source({ status: 'idle' })]);
    expect(sends[0]?.event).toBe('end');
    expect(sends[0]?.dismissAfterMs).toBe(SESSION_CARD_FINISHED_DISMISS_MS);

    await deliver(deps, 'end_all');
    expect(sends[1]).toMatchObject({ event: 'end', dismissAfterMs: 0 });
    expect(sends[1]?.content.title).toBeNull();
  });

  it('builds one high-priority data-only Expo message per Android session', () => {
    const message = sessionLiveUpdateExpoMessage({
      token: 'ExponentPushToken[aaa]',
      sessionId: 'ses_1',
      event: 'update',
      content: shown(source({})),
    });
    expect(message).toMatchObject({
      to: 'ExponentPushToken[aaa]',
      priority: 'high',
      sound: null,
      _contentAvailable: true,
      data: { type: 'session_live_update', schemaVersion: 1, event: 'update' },
    });
  });
});
