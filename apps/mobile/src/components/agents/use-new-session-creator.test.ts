/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake mutate factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- creator and generation-fenced draft-load suites share this file */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import {
  resolveRestoredNewSessionPrompt,
  useFencedDraftLoad,
  useNewSessionCreator,
  useNewSessionDraft,
  useRemoteSpawnDraftCleanup,
} from './use-new-session-creator';
import { clearDraft, flushDraft, loadDraft } from '@/lib/persist/drafts';

const routerPushMock = vi.hoisted(() => vi.fn());
const navigationDispatchMock = vi.hoisted(() => vi.fn());
const mutateMock = vi.hoisted(() => vi.fn());
const invalidateMock = vi.hoisted(() => vi.fn(async () => undefined));
const captureEventMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const hapticsNotificationMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
  useNavigation: () => ({ dispatch: navigationDispatchMock }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: hapticsNotificationMock,
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('sonner-native', () => ({
  toast: { error: toastErrorMock },
}));

vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: invalidateMock,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: captureEventMock,
  SESSION_CREATED_EVENT: 'session_created',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: mutateMock } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: mutateMock } } },
  },
  useTRPC: () => ({ mockTrpc: true }),
}));

vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({
  generateMessageId: () => 'msg_test',
}));

vi.mock('@/lib/persist/drafts', () => ({
  isStringDraft: vi.fn(),
  loadDraft: vi.fn(
    async (_userId: string, _entityKey: string, _isValid: unknown): Promise<string | null> => null
  ),
  NEW_SESSION_DRAFT_KEY: 'agent-composer:new',
  saveDraft: vi.fn(),
  flushDraft: vi.fn(async () => undefined),
  clearDraft: vi.fn(async () => undefined),
}));

type CreatorInput = Parameters<typeof useNewSessionCreator>[0];
type CreatorResult = ReturnType<typeof useNewSessionCreator>;

const FAKE_ATTACHMENTS: CreatorInput['attachments'] = {
  attachments: [],
  addCandidates: vi.fn(async () => undefined),
  removeAttachment: vi.fn(() => undefined),
  retryAttachment: vi.fn(() => undefined),
  reset: vi.fn(() => undefined),
  isUploading: false,
  hasFailedAttachments: false,
  toWirePayload: () => undefined,
  toSubmissionPayload: () => undefined,
};

function createInput(overrides: Partial<CreatorInput> = {}): CreatorInput {
  return {
    attachments: FAKE_ATTACHMENTS,
    mode: 'code' as AgentMode,
    model: 'anthropic/claude-sonnet-4',
    organizationId: undefined,
    selectedRepo: '',
    setIsCreating: vi.fn(() => undefined),
    variant: 'medium',
    ...overrides,
  };
}

function Harness({
  input,
  resultRef,
}: {
  input: CreatorInput;
  resultRef: { current: CreatorResult | null };
}) {
  const result = useNewSessionCreator(input);
  resultRef.current = result;
  return null;
}

function mountCreator(input: CreatorInput) {
  const resultRef: { current: CreatorResult | null } = { current: null };
  act(() => {
    TestRenderer.create(createElement(Harness, { input, resultRef }));
  });
  return resultRef;
}

function requireResult(resultRef: { current: CreatorResult | null }): CreatorResult {
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useNewSessionCreator did not run');
  }
  return result;
}

// Fires the frame synchronously so the navigation RESET dispatch runs inside
// the act() block. Hoisted so the stub is not an inline callback argument
// (prefer-await-to-callbacks); the parameter is named `frame` because the
// promise plugin treats a `callback`-named parameter as a promise callback.
const requestAnimationFrameStub = (frame: () => void): number => {
  frame();
  return 0;
};

// Helper to produce a controllable promise without uninitialized variables
// (same shape as src/lib/hooks/use-tracking-permission-prompt.test.ts).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let storedResolve: ((value: T) => void) | undefined = undefined;
  const promise = new Promise<T>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      storedResolve?.(value);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mutateMock.mockResolvedValue({ kiloSessionId: 'sess-1' });
  invalidateMock.mockResolvedValue(undefined);
  hapticsNotificationMock.mockResolvedValue(undefined);
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrameStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useNewSessionCreator onCreated', () => {
  it('fires onCreated once on success, before navigating', async () => {
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = 'Hello agent';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(routerPushMock).toHaveBeenCalledWith(expect.stringContaining('agent-chat/sess-1'));
    expect(captureEventMock).toHaveBeenCalledWith('session_created', expect.anything());
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('never fires onCreated when prepareSession rejects, and preserves the draft', async () => {
    mutateMock.mockRejectedValueOnce(new Error('boom'));
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = 'Hello agent';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(onCreated).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('does not prepare (and never fires onCreated) when the draft is empty', async () => {
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = '   ';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(mutateMock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });
});

describe('resolveRestoredNewSessionPrompt', () => {
  it('resolves a restored draft into sendable prompt state without an edit', () => {
    expect(resolveRestoredNewSessionPrompt('Restored draft prompt')).toEqual({
      prompt: 'Restored draft prompt',
      hasPrompt: true,
    });
  });

  it('keeps submit disabled for whitespace-only or absent restored drafts', () => {
    expect(resolveRestoredNewSessionPrompt('   ')).toEqual({ prompt: '   ', hasPrompt: false });
    expect(resolveRestoredNewSessionPrompt(undefined)).toEqual({ prompt: '', hasPrompt: false });
  });
});

describe('restored new-session submit', () => {
  it('sends the restored prompt without editing once the route seeds the prompt ref', async () => {
    const resultRef = mountCreator(createInput({ organizationId: 'org-1' }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    // Mirrors the route's draft-settle seeding: `resolveRestoredNewSessionPrompt`
    // feeds the creator's promptRef with the stored text and enables submit.
    const restored = resolveRestoredNewSessionPrompt('Restored draft prompt');
    promptRef.current = restored.prompt;

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Restored draft prompt' })
    );
    expect(routerPushMock).toHaveBeenCalledWith(expect.stringContaining('agent-chat/sess-1'));
  });
});

type DraftLoadState = { settled: boolean; text: string | null };

function NewSessionDraftHarness({
  userId,
  isIdentityLoading,
  onRender,
}: {
  userId: string | undefined;
  isIdentityLoading: boolean;
  onRender: (state: DraftLoadState) => void;
}) {
  const state = useNewSessionDraft({ userId, isIdentityLoading });
  onRender(state);
  return null;
}

function FencedDraftHarness({
  userId,
  isIdentityLoading,
  entityKey,
  onRender,
}: {
  userId: string | undefined;
  isIdentityLoading: boolean;
  entityKey: string;
  onRender: (state: DraftLoadState) => void;
}) {
  const state = useFencedDraftLoad({ userId, isIdentityLoading, entityKey });
  onRender(state);
  return null;
}

describe('useNewSessionDraft generation fencing', () => {
  it('never publishes an old account load after an account switch', async () => {
    const firstLoad = deferred<string | null>();
    const secondLoad = deferred<string | null>();
    vi.mocked(loadDraft)
      .mockImplementationOnce(async () => firstLoad.promise)
      .mockImplementationOnce(async () => secondLoad.promise);

    const renders: DraftLoadState[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    act(() => {
      renderer = TestRenderer.create(
        createElement(NewSessionDraftHarness, {
          userId: 'u1',
          isIdentityLoading: false,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });

    // Switch accounts while the first account's load is still in flight.
    act(() => {
      renderer?.update(
        createElement(NewSessionDraftHarness, {
          userId: 'u2',
          isIdentityLoading: false,
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });

    // The old account's load resolves late: it must not publish into the new
    // account's screen.
    await act(async () => {
      firstLoad.resolve('old account draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: false, text: null });

    // The new account's load resolves: it publishes.
    await act(async () => {
      secondLoad.resolve('new account draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, text: 'new account draft' });
    expect(vi.mocked(loadDraft)).toHaveBeenCalledWith(
      'u2',
      'agent-composer:new',
      expect.anything()
    );
  });
});

describe('useFencedDraftLoad generation fencing', () => {
  it('never publishes an old session load after the entity key changes', async () => {
    const firstLoad = deferred<string | null>();
    const secondLoad = deferred<string | null>();
    vi.mocked(loadDraft)
      .mockImplementationOnce(async () => firstLoad.promise)
      .mockImplementationOnce(async () => secondLoad.promise);

    const renders: DraftLoadState[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    act(() => {
      renderer = TestRenderer.create(
        createElement(FencedDraftHarness, {
          userId: 'u1',
          isIdentityLoading: false,
          entityKey: 'agent-composer:sess-1',
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });

    // The route swaps to another session while the first load is in flight.
    act(() => {
      renderer?.update(
        createElement(FencedDraftHarness, {
          userId: 'u1',
          isIdentityLoading: false,
          entityKey: 'agent-composer:sess-2',
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });

    // The old session's load resolves late: it must not publish.
    await act(async () => {
      firstLoad.resolve('old session draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: false, text: null });

    // The current session's load resolves: it publishes.
    await act(async () => {
      secondLoad.resolve('new session draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: true, text: 'new session draft' });
    expect(vi.mocked(loadDraft)).toHaveBeenCalledWith(
      'u1',
      'agent-composer:sess-2',
      expect.anything()
    );
  });

  it('never publishes a load that resolves after unmount', async () => {
    const gate = deferred<string | null>();
    vi.mocked(loadDraft).mockImplementationOnce(async () => gate.promise);

    const renders: DraftLoadState[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    act(() => {
      renderer = TestRenderer.create(
        createElement(FencedDraftHarness, {
          userId: 'u1',
          isIdentityLoading: false,
          entityKey: 'agent-composer:sess-1',
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    act(() => {
      renderer?.unmount();
    });

    await act(async () => {
      gate.resolve('late draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: false, text: null });
  });
});

type RemoteSpawnDraftCleanupResult = ReturnType<typeof useRemoteSpawnDraftCleanup>;

function RemoteSpawnDraftCleanupHarness({
  userId,
  resultRef,
}: {
  userId: string | undefined;
  resultRef: { current: RemoteSpawnDraftCleanupResult | null };
}) {
  const result = useRemoteSpawnDraftCleanup({ userId });
  resultRef.current = result;
  return null;
}

function mountRemoteSpawnDraftCleanup(userId: string | undefined): {
  renderer: TestRenderer.ReactTestRenderer | undefined;
  resultRef: { current: RemoteSpawnDraftCleanupResult | null };
} {
  const resultRef: { current: RemoteSpawnDraftCleanupResult | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(RemoteSpawnDraftCleanupHarness, { userId, resultRef })
    );
  });
  return { renderer, resultRef };
}

describe('useRemoteSpawnDraftCleanup remote-spawn clear', () => {
  beforeEach(() => {
    vi.mocked(clearDraft).mockClear();
    vi.mocked(flushDraft).mockClear();
  });

  it('clears agent-composer:new when the screen unmounts after a remote spawn attempt', async () => {
    const { renderer, resultRef } = mountRemoteSpawnDraftCleanup('u1');
    act(() => {
      resultRef.current?.markRemoteSpawnAttempted();
    });
    // A failed spawn keeps the screen mounted (toast, stay): while mounted,
    // the draft must be preserved for the retry.
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalled();

    // A successful spawn replaces the screen: the unmount clears the consumed
    // draft so the submitted prompt cannot reappear on the next visit.
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(clearDraft)).toHaveBeenCalledWith('u1', 'agent-composer:new');
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalledWith('u1', 'agent-composer:new');
  });

  it('flushes (never clears) the draft when the screen unmounts without an attempt', async () => {
    const { renderer } = mountRemoteSpawnDraftCleanup('u1');
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(flushDraft)).toHaveBeenCalledWith('u1', 'agent-composer:new');
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
  });

  it('never clears or flushes when the userId is unknown', async () => {
    const { renderer, resultRef } = mountRemoteSpawnDraftCleanup(undefined);
    act(() => {
      resultRef.current?.markRemoteSpawnAttempted();
    });
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalled();
  });
});
