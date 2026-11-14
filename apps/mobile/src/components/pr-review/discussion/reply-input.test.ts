// Four-state coverage for the UGC Terms gate (`ensureTermsAcceptedOutcome`).
//
//   - happy:          accept succeeds → `accepted`.
//   - retryable:      accept fails transiently → Retry CTA → retry succeeds.
//   - non-retryable:  accept rejected as stale (BAD_REQUEST) → `outdated`.
//   - empty:          already accepted → `accepted` with no gate shown.
//
// `Alert.alert` is captured so the test can press the Accept / Retry /
// Cancel buttons the gate renders. The gate is a pure async function, so no
// React mounting is required; the mounted reply surfaces live in
// `reply-input.mounted.test.tsx`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { ensureTermsAcceptedOutcome } from './reply-input';

type AlertButton = { text: string; style?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };

const { alertCalls, getTermsStatusMock, acceptTermsMock } = vi.hoisted(() => ({
  alertCalls: [] as AlertCall[],
  getTermsStatusMock: vi.fn(),
  acceptTermsMock: vi.fn(),
}));

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});


vi.mock('react-native', () => ({
  Alert: {
    alert: (title: string, message: string, buttons: AlertButton[]) => {
      alertCalls.push({ title, message, buttons });
    },
  },
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('expo-web-browser', () => ({
  WebBrowser: { openBrowserAsync: vi.fn() },
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    moderation: {
      getTermsStatus: { query: () => getTermsStatusMock() },
      acceptTerms: { mutate: (input: unknown) => acceptTermsMock(input) },
    },
  },
}));

vi.mock('@/lib/config', () => ({
  WEB_BASE_URL: 'https://example.com',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));

// `reply-input` imports the durable-draft chain, which pulls in the native
// encrypted-kv → expo-secure-store → expo-modules-core chain that the node
// test environment cannot resolve. Mock the persist chain and the identity
// hook so this suite stays node-only.
vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  prReplyDraftKey: vi.fn(() => 'pr-reply:key'),
  prMergeDraftKey: vi.fn(),
  prCommentDraftKey: vi.fn(),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: true, value: null }),
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  getCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

/** Drains microtasks so the awaited getTermsStatus/acceptTerms settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function lastAlert(): AlertCall {
  const call = alertCalls.at(-1);
  if (!call) {
    throw new Error('No Alert was shown');
  }
  return call;
}

function pressButton(text: string): void {
  const button = lastAlert().buttons.find(b => b.text === text);
  if (!button) {
    throw new Error(`Button "${text}" not found`);
  }
  button.onPress?.();
}

function staleVersionError(): Error {
  const error = new Error('invalid_terms');
  Object.assign(error, { data: { code: 'BAD_REQUEST' } });
  return error;
}

describe('ensureTermsAcceptedOutcome', () => {
  beforeEach(() => {
    alertCalls.length = 0;
    getTermsStatusMock.mockReset();
    acceptTermsMock.mockReset();
  });

  it('happy: resolves accepted when the user accepts now', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockResolvedValue({ ok: true });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();

    await expect(promise).resolves.toEqual({ kind: 'accepted' });
  });

  it('retryable: a transient accept failure shows a Retry CTA and retries the accept', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ ok: true });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();
    expect(lastAlert().buttons.map(button => button.text)).toContain('Retry');
    pressButton('Retry');
    await flush();

    await expect(promise).resolves.toEqual({ kind: 'accepted' });
    expect(acceptTermsMock).toHaveBeenCalledTimes(2);
  });

  it('retryable: cancelling the Retry CTA resolves dismissed without posting', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockRejectedValueOnce(new Error('Network request failed'));

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();
    pressButton('Cancel');
    await flush();

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
  });

  it('non-retryable: a stale-version reject resolves outdated (terminal, no post)', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockRejectedValueOnce(staleVersionError());

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');
    await flush();

    await expect(promise).resolves.toEqual({ kind: 'outdated' });
  });

  it('empty: already accepted resolves accepted without showing the gate', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'accepted' });
    expect(alertCalls).toHaveLength(0);
  });

  it('dismissed: cancelling the gate resolves dismissed', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Cancel');
    await flush();

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
    expect(acceptTermsMock).not.toHaveBeenCalled();
  });

  it('reports a getTermsStatus failure as unknown, not as acceptance', async () => {
    getTermsStatusMock.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'unknown' });
    expect(alertCalls).toHaveLength(0);
  });
});
