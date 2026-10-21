import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { type AppActionRequest, type AppActionResult } from './app-action-contract';
import { dispatchAppActionRequest, registerAppActionDispatcher } from './app-action-dispatch';
import {
  getPendingAppAction,
  subscribePendingAppAction,
  takePendingAppAction,
} from './pending-app-action';

const mocks = vi.hoisted(() => ({
  registerNativeAppActionDispatcher: vi.fn(),
  startAgentNeedsConfirmation: vi.fn(),
  captureException: vi.fn(),
  startAgent: vi.fn(),
  confirmStartAgent: vi.fn(),
}));

vi.mock('./native-bridge', () => ({
  registerNativeAppActionDispatcher: mocks.registerNativeAppActionDispatcher,
  startAgentNeedsConfirmation: mocks.startAgentNeedsConfirmation,
}));

// The registered handler dispatches with the default deps, which import the
// real action path lazily. This suite stubs those entries so a run does not
// load the create graph or a native dialog; the real classification is
// `start-agent.test.ts`'s.
vi.mock('./start-agent', () => ({ startAgent: mocks.startAgent }));
vi.mock('./start-agent-confirmation', () => ({
  confirmStartAgent: mocks.confirmStartAgent,
}));

vi.mock('@sentry/react-native', () => ({ captureException: mocks.captureException }));

beforeEach(() => {
  vi.resetAllMocks();
  takePendingAppAction();
});

/**
 * The one registration hand-shake: install the JS dispatcher, replay what
 * arrived while the app was cold, and answer a live payload with the outcome the
 * app shows. The dispatch itself, including whether a `StartAgent` asks first,
 * is the sibling suite's.
 */
describe('registerAppActionDispatcher', () => {
  /** The mock bridge echoing the dispatcher-registration shape the real one returns. */
  function mockRegistration(buffered: unknown[]): void {
    mocks.registerNativeAppActionDispatcher.mockImplementation(
      (handler: (payload: unknown) => Promise<AppActionResult>) => ({
        handle: handler,
        buffered,
      })
    );
  }

  it('replays the buffered payloads in order and keeps dispatching in-app', async () => {
    const parked: AppActionRequest[] = [];
    const unsubscribe = subscribePendingAppAction(() => {
      const request = getPendingAppAction();
      if (request !== null) {
        parked.push(request);
      }
    });
    mockRegistration([
      { action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' },
      { action: 'OpenSession', sessionId: 'ses_last' },
    ]);
    await registerAppActionDispatcher();
    expect(mocks.registerNativeAppActionDispatcher).toHaveBeenCalledOnce();
    expect(parked).toEqual([
      { action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' },
      { action: 'OpenSession', sessionId: 'ses_last' },
    ]);
    unsubscribe();
  });

  it('drops a buffered payload the contract rejects and still replays the rest', async () => {
    mockRegistration([{ action: 'NotAnAction' }, { action: 'OpenSession', sessionId: 'ses_2' }]);
    await registerAppActionDispatcher();
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_2' });
  });

  it('answers the live payloads the native module hands the registered handler', async () => {
    const registered: ((payload: unknown) => Promise<AppActionResult>)[] = [];
    mocks.registerNativeAppActionDispatcher.mockImplementation(
      async (handler: (payload: unknown) => Promise<AppActionResult>) => {
        registered.push(handler);
        await Promise.resolve();
        return { handle: handler, buffered: [] };
      }
    );
    await registerAppActionDispatcher();
    const handle = registered[0];
    expect(handle).toBeDefined();
    await expect(handle?.({ action: 'OpenNeedsInput' })).resolves.toEqual({
      ok: true,
      action: 'OpenNeedsInput',
      message: '',
    });
    await expect(handle?.('not a payload')).rejects.toThrow(
      'does not match the app action contract'
    );
  });

  it('asks the user for a StartAgent the platform entry point delivers, then runs it', async () => {
    // The Android entry point declares that any app can reach it, so the
    // handler asks before the action path runs.
    mocks.startAgentNeedsConfirmation.mockReturnValue(true);
    mocks.confirmStartAgent.mockResolvedValue(true);
    mocks.startAgent.mockResolvedValue({
      ok: false,
      action: 'StartAgent',
      retryable: false,
      code: 'empty-prompt',
      message: i18n.t('appActions.start.promptRequired'),
    });
    const registered: ((payload: unknown) => Promise<AppActionResult>)[] = [];
    mocks.registerNativeAppActionDispatcher.mockImplementation(
      (handler: (payload: unknown) => Promise<AppActionResult>) => {
        registered.push(handler);
        return { handle: handler, buffered: [] };
      }
    );
    await registerAppActionDispatcher();
    await expect(registered[0]?.({ action: 'start-agent', prompt: '   ' })).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      retryable: false,
      code: 'empty-prompt',
      message: i18n.t('appActions.start.promptRequired'),
    });
    expect(mocks.confirmStartAgent).toHaveBeenCalledExactlyOnceWith({
      action: 'StartAgent',
      prompt: '   ',
    });
    expect(mocks.startAgent).toHaveBeenCalledExactlyOnceWith({ prompt: '   ' });
  });

  it('starts nothing when the user declines a StartAgent the entry point delivers', async () => {
    mocks.startAgentNeedsConfirmation.mockReturnValue(true);
    mocks.confirmStartAgent.mockResolvedValue(false);
    const registered: ((payload: unknown) => Promise<AppActionResult>)[] = [];
    mocks.registerNativeAppActionDispatcher.mockImplementation(
      (handler: (payload: unknown) => Promise<AppActionResult>) => {
        registered.push(handler);
        return { handle: handler, buffered: [] };
      }
    );
    await registerAppActionDispatcher();
    await expect(registered[0]?.({ action: 'StartAgent', prompt: 'deploy' })).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      code: 'declined',
      retryable: false,
      message: '',
    });
    expect(mocks.startAgent).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toBeNull();
  });

  it('runs a StartAgent the intent surface delivers without a dialog', async () => {
    mocks.startAgentNeedsConfirmation.mockReturnValue(false);
    mocks.startAgent.mockResolvedValue({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_9',
      href: '/(app)/agent-chat/ses_9',
      message: 'Agent started',
    });
    const registered: ((payload: unknown) => Promise<AppActionResult>)[] = [];
    mocks.registerNativeAppActionDispatcher.mockImplementation(
      (handler: (payload: unknown) => Promise<AppActionResult>) => {
        registered.push(handler);
        return { handle: handler, buffered: [] };
      }
    );
    await registerAppActionDispatcher();
    await expect(registered[0]?.({ action: 'StartAgent', prompt: 'ship it' })).resolves.toEqual({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_9',
      href: '/(app)/agent-chat/ses_9',
      message: 'Agent started',
    });
    expect(mocks.confirmStartAgent).not.toHaveBeenCalled();
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_9' });
  });

  it('works with no native module at all', async () => {
    mockRegistration([]);
    await expect(registerAppActionDispatcher()).resolves.toBeUndefined();
    await expect(
      dispatchAppActionRequest({ action: 'OpenSession', sessionId: 'ses_1' })
    ).resolves.toMatchObject({ ok: true });
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_1' });
  });

  it('reports a registration failure without leaving the boot path rejected', async () => {
    mocks.registerNativeAppActionDispatcher.mockRejectedValue(new Error('no bridge'));
    await expect(registerAppActionDispatcher()).resolves.toBeUndefined();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });
});
