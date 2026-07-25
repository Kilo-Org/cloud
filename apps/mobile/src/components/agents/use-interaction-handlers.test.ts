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

function renderInteractionHandlers(args: InteractionHandlersArgs) {
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
      return mountHandlers(args);
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
    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(true);
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('kilo-session-1', 'R1'),
      })
    ).toBe(false);
    expect(__peekSessionAttentionForTests('kilo-session-1')).toEqual({ raiseId: null });
    // Must key by kilo id, never the cloud-agent id.
    expect(isAttentionAcked('cloud-agent-id', 'R1')).toBe(false);
    expect(captureEvent).toHaveBeenCalledWith('question_answered', {
      surface: 'remote-session',
      skipped: false,
    });
    expect(toastError).not.toHaveBeenCalled();
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
    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(true);
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
    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(true);
    expect(captureEvent).toHaveBeenCalledWith('permission_responded', {
      surface: 'remote-session',
      response: 'once',
    });
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

    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(false);
    expect(__peekSessionAttentionForTests('kilo-session-1')).toBeUndefined();
    expect(
      shouldShowNeedsInput({
        status: 'question',
        raiseId: 'R1',
        isAcked: isAttentionAcked('kilo-session-1', 'R1'),
      })
    ).toBe(true);
    expect(toastError).toHaveBeenCalledWith('Failed to submit answer');
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

    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to skip question');
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

    expect(isAttentionAcked('kilo-session-1', 'R1')).toBe(false);
    expect(toastError).toHaveBeenCalledWith('Failed to respond to permission request');
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

    expect(isAttentionAcked('session-a', 'R1')).toBe(true);
    expect(isAttentionAcked('session-b', 'R1')).toBe(false);
  });
});
