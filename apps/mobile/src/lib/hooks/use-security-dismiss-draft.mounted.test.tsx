/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */

// Dismiss-draft persistence contract: the hook writes the draft on persist,
// clears it on clear, and re-hydrates the stored value on remount — so a
// pre-accept failure survives navigation and an accepted dismissal does not.

import { createElement, useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isSecurityDismissDraft,
  listSecurityDismissFailures,
  useSecurityDismissDraft,
  useSecurityDismissFailures,
} from './use-security-dismiss-draft';
import { flushDraft, resetDraftTimersForTests } from '@/lib/persist/drafts';

// In-memory KV mirror, same shape as drafts.test.ts.
const kvStore = new Map<string, { scope: string; k: string; v: string; updatedAt: number }>();
let nextUpdatedAt = 1;

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1' }),
}));
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));
// The hook now flushes on unmount/background via useDraftFlushOnBackground,
// which imports AppState from react-native (Flow source trips rolldown's SSR
// transform in node env).
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

function seedStoredValue(scope: string, k: string, v: string): void {
  kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
  nextUpdatedAt += 1;
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  nextUpdatedAt = 1;
  resetDraftTimersForTests();
  kvMock.getItem.mockImplementation(
    async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
  );
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
    nextUpdatedAt += 1;
  });
  kvMock.removeItem.mockImplementation(async (scope, k) => {
    kvStore.delete(storageKey(scope, k));
  });
  kvMock.listEntries.mockImplementation(async scope =>
    [...kvStore.values()]
      .filter(entry => entry.scope === scope)
      .toSorted((a, b) => a.updatedAt - b.updatedAt)
      .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
  );
});

describe('isSecurityDismissDraft', () => {
  it('accepts a well-formed dismiss draft', () => {
    expect(
      isSecurityDismissDraft({ reason: 'not_used', comment: '', lastError: null, retryable: null })
    ).toBe(true);
    expect(
      isSecurityDismissDraft({
        reason: 'not_used',
        comment: 'x',
        lastError: 'boom',
        retryable: true,
      })
    ).toBe(true);
  });

  it('rejects malformed values', () => {
    expect(isSecurityDismissDraft(null)).toBe(false);
    expect(isSecurityDismissDraft('x')).toBe(false);
    expect(
      isSecurityDismissDraft({ reason: 1, comment: '', lastError: null, retryable: null })
    ).toBe(false);
    expect(
      isSecurityDismissDraft({ reason: 'r', comment: '', lastError: 5, retryable: null })
    ).toBe(false);
    expect(
      isSecurityDismissDraft({ reason: 'r', comment: '', lastError: null, retryable: 'yes' })
    ).toBe(false);
  });
});

describe('listSecurityDismissFailures', () => {
  it('returns only failed dismiss drafts in the scope', async () => {
    seedStoredValue(
      'draft:u1',
      'security-dismiss:personal:f1',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: 'boom', retryable: true })
    );
    // A different scope and a non-failed draft are both skipped.
    seedStoredValue(
      'draft:u1',
      'security-dismiss:org-1:f2',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: 'other', retryable: false })
    );
    seedStoredValue(
      'draft:u1',
      'security-dismiss:personal:f3',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: null, retryable: null })
    );

    await expect(listSecurityDismissFailures('u1', 'personal')).resolves.toEqual([
      { findingId: 'f1', lastError: 'boom', retryable: true },
    ]);
  });
});

type HookResult = ReturnType<typeof useSecurityDismissDraft>;

let latest: HookResult | undefined = undefined;

function Probe({ scope, findingId }: Readonly<{ scope: string; findingId: string }>) {
  const result = useSecurityDismissDraft(scope, findingId);
  useEffect(() => {
    latest = result;
  });
  return null;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function waitForHydrated(): Promise<void> {
  const isHydrated = () => latest?.hydrated === true;
  for (let i = 0; i < 20 && !isHydrated(); i += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between act cycles
    await flushAsync();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !predicate(); i += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between act cycles
    await flushAsync();
  }
}

type FailuresResult = ReturnType<typeof useSecurityDismissFailures>;

let latestFailures: FailuresResult | undefined = undefined;

function ProbeFailures({ scope }: Readonly<{ scope: string }>) {
  const result = useSecurityDismissFailures(scope);
  useEffect(() => {
    latestFailures = result;
  });
  return null;
}

describe('useSecurityDismissDraft remount', () => {
  it('restores the stored error after a remount following onError', async () => {
    const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();
    expect(latest?.draft).toBeNull();

    // Simulate onError: persist the failure, then force the debounced write.
    act(() => {
      latest?.persist({ reason: 'not_used', comment: '', lastError: 'boom', retryable: true });
    });
    await flushDraft('u1', 'security-dismiss:personal:f1');

    // Remount: the stored error must come back.
    act(() => {
      holder.current?.unmount();
    });
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();

    expect(latest?.draft).toEqual({
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      retryable: true,
    });
  });

  it('shows no draft after a remount following accept (clear)', async () => {
    const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();

    act(() => {
      latest?.persist({ reason: 'not_used', comment: '', lastError: null, retryable: null });
    });
    await flushDraft('u1', 'security-dismiss:personal:f1');

    // Simulate accept: clear the draft.
    act(() => {
      latest?.clear();
    });

    act(() => {
      holder.current?.unmount();
    });
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();

    expect(latest?.draft).toBeNull();
  });
});

describe('useSecurityDismissDraft refresh and flush', () => {
  it('refresh re-reads the stored draft without a remount', async () => {
    const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();
    expect(latest?.draft).toBeNull();

    // A failure lands in the store after mount (as if the dismiss sheet
    // persisted it); refresh must surface it without a remount.
    seedStoredValue(
      'draft:u1',
      'security-dismiss:personal:f1',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: 'boom', retryable: true })
    );

    act(() => {
      latest?.refresh();
    });
    await waitFor(() => latest?.draft?.lastError === 'boom');

    expect(latest?.draft).toEqual({
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      retryable: true,
    });
  });

  it('flushes the pending write on unmount so a kill inside the window does not drop it', async () => {
    const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();

    act(() => {
      latest?.persist({ reason: 'not_used', comment: '', lastError: 'boom', retryable: true });
    });
    // No manual flush: unmount must flush the pending debounced write.
    act(() => {
      holder.current?.unmount();
    });
    await waitFor(
      () => kvStore.get(storageKey('draft:u1', 'security-dismiss:personal:f1')) !== undefined
    );

    // Remount: the flushed draft must come back.
    act(() => {
      holder.current = TestRenderer.create(
        createElement(Probe, { scope: 'personal', findingId: 'f1' })
      );
    });
    await waitForHydrated();

    expect(latest?.draft).toEqual({
      reason: 'not_used',
      comment: '',
      lastError: 'boom',
      retryable: true,
    });
  });
});

describe('useSecurityDismissFailures refresh', () => {
  it('refresh re-reads the scope failures without a remount', async () => {
    seedStoredValue(
      'draft:u1',
      'security-dismiss:personal:f1',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: 'boom', retryable: true })
    );

    const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      holder.current = TestRenderer.create(createElement(ProbeFailures, { scope: 'personal' }));
    });
    await waitFor(() => latestFailures?.failures.length === 1);
    expect(latestFailures?.failures).toEqual([
      { findingId: 'f1', lastError: 'boom', retryable: true },
    ]);

    // A second failure lands in the store after mount; refresh must surface it.
    seedStoredValue(
      'draft:u1',
      'security-dismiss:personal:f2',
      JSON.stringify({ reason: 'not_used', comment: '', lastError: 'other', retryable: false })
    );

    act(() => {
      latestFailures?.refresh();
    });
    await waitFor(() => latestFailures?.failures.length === 2);

    expect(latestFailures?.failures).toEqual([
      { findingId: 'f1', lastError: 'boom', retryable: true },
      { findingId: 'f2', lastError: 'other', retryable: false },
    ]);
  });
});
