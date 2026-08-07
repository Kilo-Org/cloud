/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as src/test/render-with-providers.tsx) */
/* eslint-disable eslint/max-classes-per-file -- hoisted mock classes for two different packages */
import { createElement, type ReactElement, type ReactNode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { KiloChatProvider } from './kilo-chat-provider';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const acquire = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const release = vi.fn();

  // Must be a real class (not vi.fn()) because it is instantiated with `new`.
  class MockEventServiceClient {
    acquire = acquire;
    release = release;
  }

  // eslint-disable-next-line typescript-eslint/no-extraneous-class -- hoisted mock stub for constructor
  class MockKiloChatClient {}

  const subscribeToKiloChatTokenResponses = vi.fn(() => vi.fn());
  const clearKiloChatTokenCache = vi.fn();
  const useKiloChatTokenGetter = vi.fn(() => vi.fn().mockResolvedValue('mock-token'));
  const useKiloChatTokenResponseGetter = vi.fn(() =>
    vi.fn().mockResolvedValue({ userId: 'test-user', token: 'mock-token' })
  );

  const useAppActiveAndFocused = vi.fn<() => boolean>();

  return {
    acquire,
    release,
    EventServiceClient: MockEventServiceClient,
    KiloChatClient: MockKiloChatClient,
    subscribeToKiloChatTokenResponses,
    clearKiloChatTokenCache,
    useKiloChatTokenGetter,
    useKiloChatTokenResponseGetter,
    useAppActiveAndFocused,
  };
});

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@kilocode/event-service', () => ({
  EventServiceClient: mocks.EventServiceClient,
}));

vi.mock('@kilocode/kilo-chat', () => ({
  KiloChatClient: mocks.KiloChatClient,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  KiloChatHooksProvider: ({ children }: { children: ReactNode; value: unknown }) =>
    children as ReactElement,
}));

vi.mock('@/lib/config', () => ({
  EVENT_SERVICE_URL: 'https://events.test',
  KILO_CHAT_URL: 'https://chat.test',
}));

vi.mock('./hooks/use-app-active-and-focused', () => ({
  useAppActiveAndFocused: mocks.useAppActiveAndFocused,
}));

vi.mock('./hooks/use-kilo-chat-token', () => ({
  subscribeToKiloChatTokenResponses: mocks.subscribeToKiloChatTokenResponses,
  clearKiloChatTokenCache: mocks.clearKiloChatTokenCache,
  useKiloChatTokenGetter: mocks.useKiloChatTokenGetter,
  useKiloChatTokenResponseGetter: mocks.useKiloChatTokenResponseGetter,
}));

// ── Flat render helper ─────────────────────────────────────────────────────

async function mountProvider(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(KiloChatProvider, null));
    await Promise.resolve();
  });
  const created = ref.current;
  if (!created) {
    throw new Error('mountProvider: renderer was not created');
  }
  return created;
}

async function unmountProvider(renderer: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('KiloChatProvider lifecycle', () => {
  it('mounts active, calls acquire, unmounts and releases the hold', async () => {
    mocks.useAppActiveAndFocused.mockReturnValue(true);
    vi.clearAllMocks();

    const renderer = await mountProvider();

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    await unmountProvider(renderer);

    // Active mount → cleanup must release the hold.
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('mounts inactive, calls neither acquire nor release', async () => {
    mocks.useAppActiveAndFocused.mockReturnValue(false);
    vi.clearAllMocks();

    const renderer = await mountProvider();

    // Inactive: acquires nothing, releases nothing — no unpaired release.
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();

    await unmountProvider(renderer);

    // Cleanup: holding was false, so no release on unmount either.
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('handles active → inactive → active transition without unmounting', async () => {
    mocks.useAppActiveAndFocused.mockReturnValue(true);
    vi.clearAllMocks();

    const renderer = await mountProvider();
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    // Transition to inactive — cleanup from previous active effect releases the hold.
    mocks.useAppActiveAndFocused.mockReturnValue(false);
    vi.clearAllMocks();
    await act(async () => {
      renderer.update(createElement(KiloChatProvider, null));
      await Promise.resolve();
    });
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).not.toHaveBeenCalled();

    // Transition back to active — reacquires.
    mocks.useAppActiveAndFocused.mockReturnValue(true);
    vi.clearAllMocks();
    await act(async () => {
      renderer.update(createElement(KiloChatProvider, null));
      await Promise.resolve();
    });
    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();

    // Unmount releases the reacquired hold.
    vi.clearAllMocks();
    await unmountProvider(renderer);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
