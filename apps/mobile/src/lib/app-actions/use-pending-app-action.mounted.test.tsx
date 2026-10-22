import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import type * as AppActionDispatchModule from '@/lib/app-actions/app-action-dispatch';
import {
  type AppActionRequest,
  type AppActionResult,
  type NeedsInputSession,
} from '@/lib/app-actions/app-action-contract';
import {
  getPendingAppAction,
  setPendingAppAction,
  takePendingAppAction,
} from '@/lib/app-actions/pending-app-action';
import { usePendingAppAction } from '@/lib/app-actions/use-pending-app-action';

type DispatchAppAction = typeof AppActionDispatchModule.dispatchAppActionRequest;

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  dispatch: vi.fn(),
  realDispatch: null as null | DispatchAppAction,
  confirmStart: vi.fn(),
  startAgent: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: mocks.navigate }) }));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

// The two ends of the StartAgent path stay real below their own suites: this
// file replaces the confirmation surface and the headless create so the
// dispatcher runs its real order — confirm, then create.
vi.mock('@/lib/app-actions/confirm-app-action-start', () => ({
  confirmAppActionStart: mocks.confirmStart,
}));

vi.mock('@/lib/app-actions/start-agent', () => ({ startAgent: mocks.startAgent }));

// The refusal decision stays real — it is the contract's, and the hook must
// consume the real one. Only the dispatch is replaced, by a function that can
// run the real one with its default dependencies; the StartAgent branch would
// otherwise load the headless create's module graph.
vi.mock('@/lib/app-actions/app-action-dispatch', async importOriginal => {
  const actual = await importOriginal<typeof AppActionDispatchModule>();
  mocks.realDispatch = actual.dispatchAppActionRequest;
  return { ...actual, dispatchAppActionRequest: mocks.dispatch };
});

/** The real dispatcher with the default dependencies the mocks install. */
function dispatchWithDefaults(request: AppActionRequest): Promise<AppActionResult> {
  const dispatch = mocks.realDispatch;
  if (dispatch === null) {
    throw new Error('the real dispatcher was not loaded');
  }
  return dispatch(request);
}

type HarnessProps = {
  isError: boolean;
  isLoading: boolean;
  needsInputRows: NeedsInputSession[];
  orgLoaded: boolean;
};

const SETTLED: HarnessProps = {
  isError: false,
  isLoading: false,
  needsInputRows: [],
  orgLoaded: true,
};

function Harness(props: HarnessProps): null {
  usePendingAppAction(props);
  return null;
}

function mount(props: HarnessProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(
  renderer: TestRenderer.ReactTestRenderer,
  props: HarnessProps
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(Harness, props));
  });
}

describe('usePendingAppAction', () => {
  beforeEach(() => {
    // React 19 requires the act environment flag before `act` supports
    // effects (same setup as use-pending-deep-link-restore.mounted.test.tsx).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    mocks.confirmStart.mockResolvedValue(true);
    takePendingAppAction();
  });

  afterEach(() => {
    takePendingAppAction();
  });

  it('navigates to the destination of an open action the contract resolves', () => {
    setPendingAppAction({
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/o/r/pull/7',
    });
    const renderer = mount(SETTLED);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/(app)/pr-review/o/r/7');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toBeNull();
    renderer.unmount();
  });

  it('reports the refusal for an open action that names no destination and opens nothing', async () => {
    setPendingAppAction({ action: 'OpenPullRequest', pullRequest: 'https://example.com/x' });
    const renderer = mount(SETTLED);
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('prReview.linkPasteNotAPullRequest')
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toBeNull();
    // A later re-render cannot re-fire the consumed refusal.
    await update(renderer, SETTLED);
    expect(mocks.toastError).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it('runs a parked StartAgent and shows the failure the dispatch reports', async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      action: 'StartAgent',
      retryable: true,
      code: 'start-failed',
      message: i18n.t('agentChat.session.serviceUnavailable'),
    });
    setPendingAppAction({ action: 'StartAgent', prompt: 'fix the build' });
    const renderer = mount(SETTLED);
    await update(renderer, SETTLED);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
      action: 'StartAgent',
      prompt: 'fix the build',
    });
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      i18n.t('agentChat.session.serviceUnavailable')
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('holds a parked StartAgent until the confirmation is answered', async () => {
    const answer = Promise.withResolvers<boolean>();
    mocks.confirmStart.mockReturnValue(answer.promise);
    mocks.startAgent.mockResolvedValue({
      ok: true,
      action: 'StartAgent',
      sessionId: 'ses_11',
      message: '',
    });
    mocks.dispatch.mockImplementation(dispatchWithDefaults);
    setPendingAppAction({ action: 'StartAgent', prompt: 'fix the build' });
    const renderer = mount(SETTLED);
    await update(renderer, SETTLED);
    expect(mocks.confirmStart).toHaveBeenCalledExactlyOnceWith({ prompt: 'fix the build' });
    await update(renderer, SETTLED);
    expect(mocks.startAgent).not.toHaveBeenCalled();
    await act(async () => {
      answer.resolve(true);
      await Promise.resolve();
    });
    expect(mocks.startAgent).toHaveBeenCalledExactlyOnceWith({ prompt: 'fix the build' });
    renderer.unmount();
  });

  it('creates nothing when the parked StartAgent confirmation is declined', async () => {
    mocks.confirmStart.mockResolvedValue(false);
    mocks.dispatch.mockImplementation(dispatchWithDefaults);
    setPendingAppAction({ action: 'StartAgent', prompt: 'fix the build', repository: 'o/r' });
    const renderer = mount(SETTLED);
    await update(renderer, SETTLED);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
      action: 'StartAgent',
      prompt: 'fix the build',
      repository: 'o/r',
    });
    expect(mocks.startAgent).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('opens the session a completed StartAgent parked', async () => {
    mocks.dispatch.mockImplementation(() => {
      // What the real dispatcher does with a successful create: park the
      // session it produced for the consumer.
      setPendingAppAction({ action: 'OpenSession', sessionId: 'ses_7' });
      return {
        ok: true,
        action: 'StartAgent',
        sessionId: 'ses_7',
        href: '/(app)/agent-chat/ses_7',
        message: '',
      };
    });
    setPendingAppAction({ action: 'StartAgent', prompt: 'fix the build' });
    const renderer = mount(SETTLED);
    await update(renderer, SETTLED);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/ses_7');
    renderer.unmount();
  });

  it('holds OpenNeedsInput until the live list has settled', async () => {
    const rows: NeedsInputSession[] = [{ id: 'ses_wait', status: 'question', isAcked: false }];
    setPendingAppAction({ action: 'OpenNeedsInput' });
    const renderer = mount({ ...SETTLED, isLoading: true, needsInputRows: rows });
    // The list is still loading: the request stays parked, nothing acts.
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(getPendingAppAction()).toEqual({ action: 'OpenNeedsInput' });
    // Settled: the single waiting session is the destination.
    await update(renderer, { ...SETTLED, needsInputRows: rows });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/ses_wait');
    renderer.unmount();
  });
});
