import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useInteractionHandlers } from './use-interaction-handlers';

const toastError = vi.hoisted(() => vi.fn());
const captureEvent = vi.hoisted(() => vi.fn());

vi.mock('sonner-native', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

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
      const mountHandlers = useInteractionHandlers;
      return mountHandlers(args);
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  }

  return { render };
}

describe('useInteractionHandlers request-id scoping', () => {
  it('keeps isAnswering true while the question request in flight is still the active one', async () => {
    let resolve: () => void = undefined as unknown as () => void;
    const answerPromise = new Promise<void>(_resolve => {
      resolve = _resolve;
    });
    const manager = {
      answerQuestion: vi.fn().mockReturnValue(answerPromise),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q-req-1' },
      activePermission: null,
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const result1 = render();
    expect(result1.isAnswering).toBe(false);

    const pending = result1.handleAnswerQuestion([['yes']]);
    await Promise.resolve();
    const result2 = render();
    expect(result2.isAnswering).toBe(true);

    resolve();
    await pending;
    const result3 = render();
    expect(result3.isAnswering).toBe(false);
  });

  it('clears isAnswering when the question head advances mid-flight', async () => {
    let resolve: () => void = undefined as unknown as () => void;
    const answerPromise = new Promise<void>(_resolve => {
      resolve = _resolve;
    });
    const manager = {
      answerQuestion: vi.fn().mockReturnValue(answerPromise),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q-req-1' },
      activePermission: null,
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const result1 = render();
    expect(result1.isAnswering).toBe(false);

    const pending = result1.handleAnswerQuestion([['yes']]);
    await Promise.resolve();
    const result2 = render();
    expect(result2.isAnswering).toBe(true);

    args.activeQuestion = { requestId: 'q-req-2' };
    const result3 = render();
    expect(result3.isAnswering).toBe(false);

    resolve();
    await pending;
  });

  it('guards against a late answer finally clearing a newer question spinner', async () => {
    let resolveReq1: () => void = undefined as unknown as () => void;
    let resolveReq2: () => void = undefined as unknown as () => void;
    const promiseReq1 = new Promise<void>(_resolve => {
      resolveReq1 = _resolve;
    });
    const promiseReq2 = new Promise<void>(_resolve => {
      resolveReq2 = _resolve;
    });
    const answerQuestion = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(promiseReq1)
      .mockReturnValueOnce(promiseReq2);
    const manager = {
      answerQuestion,
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn(),
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: { requestId: 'q-req-1' },
      activePermission: null,
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const pending1 = render().handleAnswerQuestion([['yes']]);
    await Promise.resolve();

    args.activeQuestion = { requestId: 'q-req-2' };
    const resultBefore = render();
    const pending2 = resultBefore.handleAnswerQuestion([['no']]);
    await Promise.resolve();

    const resultMid = render();
    expect(resultMid.isAnswering).toBe(true);

    resolveReq1();
    await pending1;
    const resultAfter = render();
    expect(resultAfter.isAnswering).toBe(true);

    resolveReq2();
    await pending2;
  });

  it('keeps isRespondingToPermission true while the request in flight is still the active one', async () => {
    let resolve: () => void = undefined as unknown as () => void;
    const respondPromise = new Promise<void>(_resolve => {
      resolve = _resolve;
    });
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockReturnValue(respondPromise),
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'req-1' },
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const result1 = render();
    expect(result1.isRespondingToPermission).toBe(false);

    const pending = result1.handleRespondToPermission('once');
    await Promise.resolve();
    const result2 = render();
    expect(result2.isRespondingToPermission).toBe(true);

    resolve();
    await pending;
    const result3 = render();
    expect(result3.isRespondingToPermission).toBe(false);
  });

  it('clears isRespondingToPermission when the head advances mid-flight', async () => {
    let resolve: () => void = undefined as unknown as () => void;
    const respondPromise = new Promise<void>(_resolve => {
      resolve = _resolve;
    });
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission: vi.fn().mockReturnValue(respondPromise),
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'req-1' },
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const result1 = render();
    expect(result1.isRespondingToPermission).toBe(false);

    const pending = result1.handleRespondToPermission('once');
    await Promise.resolve();
    const result2 = render();
    expect(result2.isRespondingToPermission).toBe(true);

    args.activePermission = { requestId: 'req-2' };
    const result3 = render();
    expect(result3.isRespondingToPermission).toBe(false);

    resolve();
    await pending;
  });

  it('guards against a late finally clearing a newer request spinner', async () => {
    let resolveReq1: () => void = undefined as unknown as () => void;
    let resolveReq2: () => void = undefined as unknown as () => void;
    const promiseReq1 = new Promise<void>(_resolve => {
      resolveReq1 = _resolve;
    });
    const promiseReq2 = new Promise<void>(_resolve => {
      resolveReq2 = _resolve;
    });
    const respondToPermission = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(promiseReq1)
      .mockReturnValueOnce(promiseReq2);
    const manager = {
      answerQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      respondToPermission,
    };
    const args: InteractionHandlersArgs = {
      manager: manager as never,
      kiloSessionId: 'kilo-session-1',
      activeQuestion: null,
      activePermission: { requestId: 'req-1' },
      surface: 'remote-session',
    };
    const { render } = renderInteractionHandlers(args);

    const pending1 = render().handleRespondToPermission('once');
    await Promise.resolve();

    args.activePermission = { requestId: 'req-2' };
    const resultBefore = render();
    const pending2 = resultBefore.handleRespondToPermission('always');
    await Promise.resolve();

    const resultMid = render();
    expect(resultMid.isRespondingToPermission).toBe(true);

    resolveReq1();
    await pending1;
    const resultAfter = render();
    expect(resultAfter.isRespondingToPermission).toBe(true);

    resolveReq2();
    await pending2;
  });
});
