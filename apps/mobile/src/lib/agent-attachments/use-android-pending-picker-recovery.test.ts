/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/auth/auth-context.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAndroidPendingPickerRecovery } from './use-android-pending-picker-recovery';

const mocks = vi.hoisted(() => ({
  userId: undefined as string | undefined,
  readPickerLaunchContext: vi.fn(),
  clearPickerLaunchContext: vi.fn(),
  consumeAndroidPendingPickerResult: vi.fn(),
  discardAndroidPendingPickerResult: vi.fn(),
  normalizeImageAsset: vi.fn(),
  addCandidates: vi.fn(),
}));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: mocks.userId }),
}));

vi.mock('@/lib/agent-attachments/picker-launch-context', () => ({
  readPickerLaunchContext: mocks.readPickerLaunchContext,
  clearPickerLaunchContext: mocks.clearPickerLaunchContext,
}));

vi.mock('@/lib/agent-attachments/pending-picker-result', () => ({
  consumeAndroidPendingPickerResult: mocks.consumeAndroidPendingPickerResult,
  discardAndroidPendingPickerResult: mocks.discardAndroidPendingPickerResult,
}));

vi.mock('@/components/agents/attachment-picker', () => ({
  normalizeImageAsset: mocks.normalizeImageAsset,
}));

let appStateListener: ((state: string) => void) | undefined = undefined;
vi.mock('react-native', () => ({
  AppState: {
    // eslint-disable-next-line prefer-await-to-callbacks -- addEventListener is inherently callback-based
    addEventListener: (event: string, cb: (state: string) => void) => {
      if (event === 'change') {
        appStateListener = cb;
      }
      return { remove: vi.fn() };
    },
  },
}));

type LaunchContext = {
  userId: string;
  surface: 'agent-new' | 'agent-chat';
  sessionId: string | null;
  launchedAt: number;
};

function makeContext(overrides: Partial<LaunchContext> = {}) {
  return {
    userId: 'user-1',
    surface: 'agent-new' as const,
    sessionId: null as string | null,
    launchedAt: Date.now(),
    ...overrides,
  };
}

function Harness() {
  useAndroidPendingPickerRecovery({
    surface: 'agent-new',
    sessionId: null,
    addCandidates: mocks.addCandidates,
  });
  return null;
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(Harness));
    await settle();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  appStateListener = undefined;
  mocks.userId = undefined;
  mocks.normalizeImageAsset.mockImplementation((asset: { uri: string }) => ({
    name: 'photo.jpg',
    uri: asset.uri,
  }));
});

describe('useAndroidPendingPickerRecovery', () => {
  it('does NOT clear or consume when the current user id is still unknown', async () => {
    mocks.userId = undefined;
    mocks.readPickerLaunchContext.mockResolvedValue(makeContext());

    await mount();

    expect(mocks.clearPickerLaunchContext).not.toHaveBeenCalled();
    expect(mocks.consumeAndroidPendingPickerResult).not.toHaveBeenCalled();
    expect(mocks.discardAndroidPendingPickerResult).not.toHaveBeenCalled();
  });

  it('discards and clears on a wrong-account mismatch', async () => {
    mocks.userId = 'user-2';
    mocks.readPickerLaunchContext.mockResolvedValue(makeContext({ userId: 'user-1' }));

    await mount();

    expect(mocks.discardAndroidPendingPickerResult).toHaveBeenCalledTimes(1);
    expect(mocks.clearPickerLaunchContext).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAndroidPendingPickerResult).not.toHaveBeenCalled();
    expect(mocks.addCandidates).not.toHaveBeenCalled();
  });

  it('discards and clears on a wrong-surface mismatch', async () => {
    mocks.userId = 'user-1';
    mocks.readPickerLaunchContext.mockResolvedValue(makeContext({ surface: 'agent-chat' }));

    await mount();

    expect(mocks.discardAndroidPendingPickerResult).toHaveBeenCalledTimes(1);
    expect(mocks.clearPickerLaunchContext).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAndroidPendingPickerResult).not.toHaveBeenCalled();
  });

  it('discards and clears on an expired context', async () => {
    mocks.userId = 'user-1';
    mocks.readPickerLaunchContext.mockResolvedValue(
      makeContext({ launchedAt: Date.now() - 11 * 60 * 1000 })
    );

    await mount();

    expect(mocks.discardAndroidPendingPickerResult).toHaveBeenCalledTimes(1);
    expect(mocks.clearPickerLaunchContext).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAndroidPendingPickerResult).not.toHaveBeenCalled();
  });

  it('consumes exactly once on a match and never re-adds the same asset', async () => {
    mocks.userId = 'user-1';
    mocks.readPickerLaunchContext.mockResolvedValue(makeContext());
    mocks.consumeAndroidPendingPickerResult.mockResolvedValue([{ uri: 'file:///photo.jpg' }]);

    await mount();

    expect(mocks.consumeAndroidPendingPickerResult).toHaveBeenCalledTimes(1);
    expect(mocks.clearPickerLaunchContext).toHaveBeenCalledTimes(1);
    expect(mocks.addCandidates).toHaveBeenCalledTimes(1);
    expect(mocks.addCandidates).toHaveBeenCalledWith([
      { name: 'photo.jpg', uri: 'file:///photo.jpg' },
    ]);
    expect(mocks.discardAndroidPendingPickerResult).not.toHaveBeenCalled();

    // A later AppState activation finds no stored context (cleared above), so
    // the pending result is never consumed or added a second time.
    mocks.readPickerLaunchContext.mockResolvedValue(null);
    await act(async () => {
      appStateListener?.('active');
      await settle();
    });

    expect(mocks.consumeAndroidPendingPickerResult).toHaveBeenCalledTimes(1);
    expect(mocks.addCandidates).toHaveBeenCalledTimes(1);
  });
});
