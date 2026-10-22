/* eslint-disable max-lines -- one cohesive suite: the fake dispatcher, the ack contracts, and the failure paths share the same harness */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __peekSessionAttentionForTests,
  __resetSessionAttentionForTests,
  isAttentionAcked,
  shouldShowNeedsInput,
} from '@/lib/session-attention';

import { useInteractionHandlers } from './use-interaction-handlers';

const toastError = vi.hoisted(() => vi.fn());
const captureEvent = vi.hoisted(() => vi.fn());

vi.mock('sonner-native', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

// Mocked at the single a11y import surface so the suite never pulls the
// Flow-typed `react-native` entry into the node vitest env.
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: vi.fn(),
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: (...args: unknown[]) => captureEvent(...args),
  PERMISSION_RESPONDED_EVENT: 'permission_responded',
  QUESTION_ANSWERED_EVENT: 'question_answered',
}));

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T) => T;
  useState: <T>(initialValue: T) => [T, (value: T | ((previous: T) => T)) => void];
};

type InteractionHandlersArgs = Parameters<typeof useInteractionHandlers>[0];
type InteractionHandlersResult = ReturnType<typeof useInteractionHandlers>;

function renderInteractionHandlers(
  args: Omit<InteractionHandlersArgs, 'readObservedRaise'> &
    Partial<Pick<InteractionHandlersArgs, 'readObservedRaise'>>
) {
  // Read per render: the scoping cases mutate `args` between renders.
  const readObservedRaise = args.readObservedRaise ?? (() => null);
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  let hookIndex = 0;

  const dispatcher: HookDispatcher = {
    useCallback: hookCallback => {
      hookIndex += 1;
      return hookCallback;
    },
    useState: initialValue => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = initialValue;
      }
      const setState = (
        value: typeof initialValue | ((previous: typeof initialValue) => typeof initialValue)
      ) => {
        hookState[stateIndex] =
          typeof value === 'function'
            ? (value as (previous: typeof initialValue) => typeof initialValue)(
                hookState[stateIndex] as typeof initialValue
              )
            : value;
      };
      return [hookState[stateIndex] as typeof initialValue, setState];
    },
  };

  function render(): InteractionHandlersResult {
    const previousDispatcher =
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    hookIndex = 0;
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try {
      // Alias avoids rules-of-hooks lexical false positives under the fake dispatcher.
      const mountHandlers = useInteractionHandlers;
      return mountHandlers({ ...args, readObservedRaise });
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  }

  return { render };
}

describe('useInteractionHandlers attention ack', () => {
  beforeEach(() => {
    __resetSessionAttentionForTests();
    toastError.mockReset();
    captureEvent.mockReset();
  });

  it('acks the kilo session id after a successful answer', async () => {
    const manager = {
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
    });

    await render().handleAnswerQuestion([['yes']]);

    expect(manager.answerQuestion).toHaveBeenCalledWith('q1', [['yes']]);
    expect(isAttentionAcked('kilo-session-1', { raiseId: 'question' })).toBe(true);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'question',
        isAcked: isAttentionAcked('kilo-session-1', { raiseId: 'question' }),
      })
    ).toBe(false);
    expect(__peekSessionAttentionForTests('kilo-session-1')).toEqual({ raiseId: 'question' });
    // Must key by kilo id, never the cloud-agent id.
    expect(isAttentionAcked('cloud-agent-id', { raiseId: 'question' })).toBe(false);
    expect(captureEvent).toHaveBeenCalledWith('question_answered', {
      surface: 'remote-session',
      skipped: false,
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('acks the raise the app observed for the session', async () => {
    const manager = {
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
      readObservedRaise: () => ({
        status: 'question',
        statusUpdatedAt: '2026-09-18T21:00:00.000Z',
      }),
    });

    await render().handleAnswerQuestion([['yes']]);

    expect(__peekSessionAttentionForTests('kilo-session-1')).toEqual({
      raiseId: '2026-09-18T21:00:00.000Z',
    });
    expect(isAttentionAcked('kilo-session-1', { raiseId: '2026-09-18T21:00:00.000Z' })).toBe(true);
    // A question raised later is a different raise and keeps its badge.
    expect(isAttentionAcked('kilo-session-1', { raiseId: '2026-09-18T21:30:00.000Z' })).toBe(false);
  });

  it.each(['answer', 'skip', 'permission'] as const)(
    'keeps the %s ack on the submitted raise when another arrives in flight',
    async operation => {
      const gate = Promise.withResolvers<undefined>();
      const manager = {
        answerQuestion: vi.fn().mockReturnValue(gate.promise),
        rejectQuestion: vi.fn().mockReturnValue(gate.promise),
        respondToPermission: vi.fn().mockReturnValue(gate.promise),
      };
      const status = operation === 'permission' ? 'permission' : 'question';
      const firstRaise = '2026-09-18T21:00:00.000Z';
      const nextRaise = '2026-09-18T21:30:00.000Z';
      let observed = { status, statusUpdatedAt: firstRaise };
      const { render } = renderInteractionHandlers({
        manager: manager as never,
        kiloSessionId: 'kilo-session-1',
        activeQuestion: { requestId: 'q1' },
        activePermission: { requestId: 'p1' },
        surface: 'remote-session',
        readObservedRaise: () => observed,
      });
      const handlers = render();
      const pending = (async () => {
        if (operation === 'answer') {
          await handlers.handleAnswerQuestion([['yes']]);
        } else if (operation === 'skip') {
          await handlers.handleRejectQuestion();
        } else {
          await handlers.handleRespondToPermission('once');
        }
      })();

      observed = { status, statusUpdatedAt: nextRaise };
      gate.resolve(undefined);
      await pending;

      expect(isAttentionAcked('kilo-session-1', { raiseId: firstRaise, status })).toBe(true);
      expect(isAttentionAcked('kilo-session-1', { raiseId: nextRaise, status })).toBe(false);
    }
  );

  it('ignores an observed raise of the other kind', async () => {
    const manager = {
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
      // The row already reads the next raise: it is not the one being answered.
      readObservedRaise: () => ({
        status: 'permission',
        statusUpdatedAt: '2026-09-18T21:00:00.000Z',
      }),
    });

    await render().handleAnswerQuestion([['yes']]);

    expect(__peekSessionAttentionForTests('kilo-session-1')).toEqual({ raiseId: 'question' });
  });

  it('acks after a successful skip/reject', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn().mockResolvedValue(undefined),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'cloud-agent',
    });

    await render().handleRejectQuestion();

    expect(manager.rejectQuestion).toHaveBeenCalledWith('q1');
    expect(isAttentionAcked('kilo-session-1', { raiseId: 'question' })).toBe(true);
    expect(captureEvent).toHaveBeenCalledWith('question_answered', {
      surface: 'cloud-agent',
      skipped: true,
    });
  });

  it('acks after a successful permission response', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockResolvedValue(undefined),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'p1' },
      surface: 'remote-session',
    });

    await render().handleRespondToPermission('once');

    expect(manager.respondToPermission).toHaveBeenCalledWith('p1', 'once');
    expect(isAttentionAcked('kilo-session-1', { raiseId: 'permission' })).toBe(true);
    expect(captureEvent).toHaveBeenCalledWith('permission_responded', {
      surface: 'remote-session',
      response: 'once',
    });
  });

  it('reports ok after a successful permission response', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockResolvedValue(undefined),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'p1' },
      surface: 'remote-session',
    });

    await expect(render().handleRespondToPermission('once')).resolves.toBe('ok');
  });

  it('reports retryable when a permission response fails transiently', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockRejectedValue(new Error('network')),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'p1' },
      surface: 'remote-session',
    });

    await expect(render().handleRespondToPermission('once')).resolves.toBe('retryable');
  });

  it('reports terminal when the permission is no longer available', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockRejectedValue({ data: { code: 'NOT_FOUND' } }),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'p1' },
      surface: 'remote-session',
    });

    await expect(render().handleRespondToPermission('once')).resolves.toBe('terminal');
  });

  it('does not ack when answer submit fails', async () => {
    const manager = {
      answerQuestion: vi.fn().mockRejectedValue(new Error('network')),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
    });

    await render().handleAnswerQuestion([['yes']]);

    expect(isAttentionAcked('kilo-session-1', { raiseId: 'question' })).toBe(false);
    expect(__peekSessionAttentionForTests('kilo-session-1')).toBeUndefined();
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'question',
        isAcked: isAttentionAcked('kilo-session-1', { raiseId: 'question' }),
      })
    ).toBe(true);
    expect(toastError).toHaveBeenCalledWith('Failed to submit answer. Please try again.');
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('does not ack when skip submit fails', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn().mockRejectedValue(new Error('network')),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
    });

    await render().handleRejectQuestion();

    expect(isAttentionAcked('kilo-session-1', { raiseId: 'question' })).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to skip question. Please try again.');
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('does not ack when permission submit fails', async () => {
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockRejectedValue(new Error('network')),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'p1' },
      surface: 'remote-session',
    });

    await render().handleRespondToPermission('reject');

    expect(isAttentionAcked('kilo-session-1', { raiseId: 'permission' })).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to respond to permission. Please try again.');
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('does not ack a different session id than the one supplied', async () => {
    const manager = {
      answerQuestion: vi.fn().mockResolvedValue(undefined),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const { render } = renderInteractionHandlers({
      manager: manager as never,
      kiloSessionId: 'session-a',
      activeQuestion: { requestId: 'q1' },
      activePermission: null,
      surface: 'remote-session',
    });

    await render().handleAnswerQuestion([['ok']]);

    expect(isAttentionAcked('session-a', { raiseId: 'question' })).toBe(true);
    expect(isAttentionAcked('session-b', { raiseId: 'question' })).toBe(false);
  });
});
