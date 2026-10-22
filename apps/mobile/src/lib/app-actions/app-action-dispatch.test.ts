import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { type AppActionRequest, type AppActionResult } from './app-action-contract';
import { dispatchAppActionRequest, unresolvedOpenActionRefusal } from './app-action-dispatch';
import { getPendingAppAction, takePendingAppAction } from './pending-app-action';

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

describe('dispatchAppActionRequest', () => {
  it('asks the user, then runs StartAgent and parks the session it created', async () => {
    const result: AppActionResult = {
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_7',
      href: '/(app)/agent-chat/ses_7',
      message: 'Agent started',
    };
    const startAgent = vi.fn().mockResolvedValue(result);
    const confirmStartAgent = vi.fn().mockResolvedValue(true);
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'fix the build', repository: 'o/r' },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual(result);
    expect(confirmStartAgent).toHaveBeenCalledExactlyOnceWith({
      action: 'StartAgent',
      prompt: 'fix the build',
      repository: 'o/r',
    });
    expect(startAgent).toHaveBeenCalledExactlyOnceWith({
      prompt: 'fix the build',
      repository: 'o/r',
    });
    expect(takePendingAppAction()).toEqual({ action: 'OpenSession', sessionId: 'ses_7' });
  });

  it('starts nothing and parks nothing when the user declines', async () => {
    const startAgent = vi.fn();
    const confirmStartAgent = vi.fn().mockResolvedValue(false);
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'fix the build' },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      code: 'declined',
      retryable: false,
      message: '',
    });
    expect(startAgent).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toBeNull();
  });

  it('runs StartAgent without asking on a surface that is not in front of the user', async () => {
    const result: AppActionResult = {
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_8',
      href: '/(app)/agent-chat/ses_8',
      message: 'Agent started',
    };
    const startAgent = vi.fn().mockResolvedValue(result);
    const confirmStartAgent = vi.fn();
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'go' },
        { startAgent, confirmStartAgent },
        {
          requireStartAgentConfirmation: false,
        }
      )
    ).resolves.toEqual(result);
    expect(confirmStartAgent).not.toHaveBeenCalled();
    expect(startAgent).toHaveBeenCalledExactlyOnceWith({ prompt: 'go' });
  });

  it('asks for a session-only request, which is the continue form', async () => {
    // A request that names a session and no prompt is the documented
    // continue/clone form; it is confirmed and run like any other StartAgent.
    const result: AppActionResult = {
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_12',
      href: '/(app)/agent-chat/ses_12',
      message: 'Agent started',
    };
    const startAgent = vi.fn().mockResolvedValue(result);
    const confirmStartAgent = vi.fn().mockResolvedValue(true);
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: '', sessionId: 'ses_1' },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual(result);
    expect(confirmStartAgent).toHaveBeenCalledExactlyOnceWith({
      action: 'StartAgent',
      prompt: '',
      sessionId: 'ses_1',
    });
    expect(startAgent).toHaveBeenCalledExactlyOnceWith({ prompt: '', sessionId: 'ses_1' });
  });

  it('refuses a promptless request without asking', async () => {
    const startAgent = vi.fn();
    const confirmStartAgent = vi.fn();
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: '   ' },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      code: 'empty-prompt',
      retryable: false,
      message: i18n.t('appActions.start.promptRequired'),
    });
    expect(confirmStartAgent).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('refuses an unusable repository without asking', async () => {
    const startAgent = vi.fn();
    const confirmStartAgent = vi.fn();
    await expect(
      dispatchAppActionRequest(
        {
          action: 'StartAgent',
          prompt: 'fix the build',
          repository: 'https://git.example.com/owner/repo',
        },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      code: 'unknown-repository',
      retryable: false,
      message: i18n.t('appActions.start.repositoryUnknown', {
        repository: 'https://git.example.com/owner/repo',
      }),
    });
    expect(confirmStartAgent).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('reports a confirmation that could not be shown as a retryable failure', async () => {
    const startAgent = vi.fn();
    const confirmStartAgent = vi.fn().mockRejectedValue(new Error('no activity'));
    await expect(
      dispatchAppActionRequest(
        { action: 'StartAgent', prompt: 'fix the build' },
        { startAgent, confirmStartAgent }
      )
    ).resolves.toEqual({
      ok: false,
      action: 'StartAgent',
      code: 'start-failed',
      retryable: true,
      message: i18n.t('agentChat.session.serviceUnavailable'),
    });
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledOnce();
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
        { startAgent, confirmStartAgent: vi.fn().mockResolvedValue(true) }
      )
    ).resolves.toEqual(failure);
    expect(getPendingAppAction()).toBeNull();
  });

  it('turns a throwing StartAgent into the retryable failure a caller can report', async () => {
    const startAgent = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await dispatchAppActionRequest(
      { action: 'StartAgent', prompt: 'go' },
      { startAgent, confirmStartAgent: vi.fn().mockResolvedValue(true) }
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
