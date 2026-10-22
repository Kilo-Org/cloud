/* eslint-disable max-lines -- one harness covers the dispatcher's action branches, the StartAgent confirmation order, and the native replay */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { type AppActionRequest, type AppActionResult } from './app-action-contract';
import {
  dispatchAppActionRequest,
  registerAppActionDispatcher,
  unresolvedOpenActionRefusal,
} from './app-action-dispatch';
import {
  getPendingAppAction,
  subscribePendingAppAction,
  takePendingAppAction,
} from './pending-app-action';

const mocks = vi.hoisted(() => ({
  registerNativeAppActionDispatcher: vi.fn(),
  captureException: vi.fn(),
  confirmStart: vi.fn(),
  startAgent: vi.fn(),
}));

vi.mock('./native-bridge', () => ({
  registerNativeAppActionDispatcher: mocks.registerNativeAppActionDispatcher,
}));

// The registered handler dispatches with the default deps, which import the
// real action path and the confirmation lazily. This suite stubs both so a run
// loads neither the create graph nor the native alert; the real classification
// is `start-agent.test.ts`'s.
vi.mock('./start-agent', () => ({ startAgent: mocks.startAgent }));

vi.mock('./confirm-app-action-start', () => ({ confirmAppActionStart: mocks.confirmStart }));

vi.mock('@sentry/react-native', () => ({ captureException: mocks.captureException }));

/** A confirmed request: the default answer every run in this suite expects. */
const CONFIRMED = Promise.resolve(true);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.confirmStart.mockReturnValue(CONFIRMED);
  takePendingAppAction();
});

describe('dispatchAppActionRequest', () => {
  it('runs StartAgent and parks the session it created', async () => {
    const result: AppActionResult = {
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_7',
      href: '/(app)/agent-chat/ses_7',
      message: 'Agent started',
    };
    const startAgent = vi.fn().mockResolvedValue(result);
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'fix the build', repository: 'o/r' },
        { confirmStart: () => CONFIRMED, startAgent }
      )
    ).resolves.toEqual(result);
    expect(startAgent).toHaveBeenCalledExactlyOnceWith({
      prompt: 'fix the build',
      repository: 'o/r',
    });
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_7' });
  });

  it('asks for confirmation of the StartAgent it is about to run', async () => {
    const confirmStart = vi.fn().mockReturnValue(CONFIRMED);
    const startAgent = vi.fn().mockResolvedValue({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_8',
      message: '',
    });
    await dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'fix the build' },
      { confirmStart, startAgent }
    );
    expect(confirmStart).toHaveBeenCalledExactlyOnceWith({ prompt: 'fix the build' });
    expect(startAgent).toHaveBeenCalledOnce();
  });

  it('does not run StartAgent before the confirmation answers', async () => {
    const answer = Promise.withResolvers<boolean>();
    const startAgent = vi.fn().mockResolvedValue({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_9',
      message: '',
    });
    const pending = dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'fix the build' },
      { confirmStart: () => answer.promise, startAgent }
    );
    await Promise.resolve();
    expect(startAgent).not.toHaveBeenCalled();
    answer.resolve(true);
    await expect(pending).resolves.toMatchObject({ ok: true, sessionId: 'ses_9' });
    expect(startAgent).toHaveBeenCalledOnce();
  });

  it('reports a cancelled confirmation without running StartAgent', async () => {
    const startAgent = vi.fn().mockResolvedValue({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_10',
      message: '',
    });
    const result = await dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'fix the build', repository: 'o/r' },
      { confirmStart: () => Promise.resolve(false), startAgent }
    );
    expect(result).toEqual({
      ok: false,
      action: 'StartAgent',
      retryable: false,
      code: 'start-cancelled',
      message: i18n.t('common.cancelled'),
    });
    expect(startAgent).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toBeNull();
  });

  it('reports a cancelled confirmation when the prompt cannot be shown', async () => {
    const startAgent = vi.fn();
    const result = await dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'fix the build' },
      { confirmStart: () => Promise.reject(new Error('no alert surface')), startAgent }
    );
    expect(result).toMatchObject({ ok: false, code: 'start-cancelled', retryable: false });
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('reports a StartAgent failure without parking a session', async () => {
    const failure: AppActionResult = {
      ok: false,
      action: 'StartAgent',
      retryable: false,
      code: 'no-repository',
      message: 'No repository',
    };
    const startAgent = vi.fn().mockResolvedValue(failure);
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'go' },
        { confirmStart: () => CONFIRMED, startAgent }
      )
    ).resolves.toEqual(failure);
    expect(getPendingAppAction()).toBeNull();
  });

  it('turns a throwing StartAgent into the retryable failure a caller can report', async () => {
    const startAgent = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'go' },
      { confirmStart: () => CONFIRMED, startAgent }
    );
    expect(result).toEqual({
      ok: false,
      action: 'StartAgent',
      retryable: true,
      code: 'start-failed',
      message: i18n.t('agentChat.session.serviceUnavailable'),
    });
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it('parks OpenNeedsInput for the tabs consumer', async () => {
    await expect(dispatchAppActionRequest({ action: 'OpenNeedsInput' })).resolves.toEqual({
      ok: true,
      action: 'OpenNeedsInput',
      message: '',
    });
    expect(takePendingAppAction()).toEqual({ action: 'OpenNeedsInput' });
  });

  it('parks a session and reports its destination', async () => {
    await expect(
      dispatchAppActionRequest({ action: 'OpenSession', sessionId: 'ses_1' })
    ).resolves.toEqual({
      ok: true,
      action: 'OpenSession',
      sessionId: 'ses_1',
      href: '/(app)/agent-chat/ses_1',
      message: '',
    });
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_1' });
  });

  it('parks a review link and reports its destination', async () => {
    const request: AppActionRequest = {
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    };
    await expect(dispatchAppActionRequest(request)).resolves.toEqual({
      ok: true,
      action: 'OpenPullRequest',
      href: '/(app)/pr-review/o/r/7',
      message: '',
    });
    expect(takePendingAppAction()).toEqual(request);
  });

  it('rejects a link that is not a review without opening anything', async () => {
    const result = await dispatchAppActionRequest({
      action: 'OpenPullRequest',
      pullRequest: 'https://example.com/x',
    });
    expect(result).toEqual({
      ok: false,
      action: 'OpenPullRequest',
      retryable: false,
      code: 'not-a-pull-request',
      message: i18n.t('prReview.linkPasteNotAPullRequest'),
    });
    expect(getPendingAppAction()).toBeNull();
  });
});

describe('unresolvedOpenActionRefusal', () => {
  it('returns the unrecognized-link refusal for a review link the resolvers do not know', () => {
    expect(
      unresolvedOpenActionRefusal({
        action: 'OpenPullRequest',
        pullRequest: 'https://example.com/x',
      })
    ).toEqual({
      ok: false,
      action: 'OpenPullRequest',
      retryable: false,
      code: 'not-a-pull-request',
      message: i18n.t('prReview.linkPasteNotAPullRequest'),
    });
  });

  it('returns null for a resolvable review link', () => {
    expect(
      unresolvedOpenActionRefusal({
        action: 'OpenPullRequest',
        pullRequest: 'https://github.com/o/r/pull/7',
      })
    ).toBeNull();
  });

  it('returns null for OpenSession with any id', () => {
    expect(unresolvedOpenActionRefusal({ action: 'OpenSession', sessionId: 'ses_1' })).toBeNull();
    expect(
      unresolvedOpenActionRefusal({ action: 'OpenSession', sessionId: 'ses_pending' })
    ).toBeNull();
  });

  it('returns null for the actions no URL can answer', () => {
    expect(unresolvedOpenActionRefusal({ action: 'OpenNeedsInput' })).toBeNull();
    expect(unresolvedOpenActionRefusal({ action: 'StartAgent', prompt: 'go' })).toBeNull();
  });
});

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

  it('answers a blank StartAgent payload with the empty-prompt refusal', async () => {
    // The OS caller named START_AGENT, so the payload is a request the action
    // path classifies — not an unrecognized payload the handler throws on. The
    // refusal is the real result the native side reports through
    // `completeAppAction`, instead of the entry point timing out.
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
    expect(mocks.startAgent).toHaveBeenCalledExactlyOnceWith({ prompt: '   ' });
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
