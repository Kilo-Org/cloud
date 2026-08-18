// Four-state coverage for the UGC Terms gate (`ensureTermsAcceptedOutcome`).
//
//   - happy:          accept succeeds → `accepted`.
//   - retryable:      accept fails transiently → Retry CTA → retry succeeds.
//   - non-retryable:  accept rejected as stale (BAD_REQUEST) → `outdated`.
//   - empty:          already accepted → `accepted` with no gate shown.
//
// `Alert.alert` is captured so the test can press the Accept / Retry /
// Cancel buttons the gate renders. The gate is a pure async function, so no
// React mounting is required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureTermsAcceptedOutcome } from './reply-input';

type AlertButton = { text?: string; onPress?: () => void };
type AlertCall = { title: string; message: string; buttons: AlertButton[] };

const { alertCalls, getTermsStatusMock, acceptTermsMock } = vi.hoisted(() => ({
  alertCalls: [] as AlertCall[],
  getTermsStatusMock: vi.fn(),
  acceptTermsMock: vi.fn(),
}));

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

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
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

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy: resolves accepted when the user accepts now', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockResolvedValue({ ok: true });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');

    await expect(promise).resolves.toEqual({ kind: 'accepted' });
    expect(acceptTermsMock).toHaveBeenCalledWith({ version: 'v1', agePosture: '13_plus' });
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

    expect(lastAlert().message).toBe(
      "Couldn't accept the Terms. Check your connection and try again."
    );
    pressButton('Retry');

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

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
    expect(acceptTermsMock).toHaveBeenCalledTimes(1);
  });

  it('non-retryable: a stale-version reject resolves outdated (terminal, no post)', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });
    acceptTermsMock.mockRejectedValueOnce(staleVersionError());

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Accept');

    await expect(promise).resolves.toEqual({ kind: 'outdated' });
    // No retry alert is shown for a terminal reject.
    expect(alertCalls).toHaveLength(1);
  });

  it('empty: already accepted resolves accepted without showing the gate', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: true, currentVersion: 'v1' });

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'accepted' });
    expect(alertCalls).toHaveLength(0);
    expect(acceptTermsMock).not.toHaveBeenCalled();
  });

  it('dismissed: cancelling the gate resolves dismissed', async () => {
    getTermsStatusMock.mockResolvedValue({ accepted: false, currentVersion: 'v1' });

    const promise = ensureTermsAcceptedOutcome();
    await flush();
    pressButton('Cancel');

    await expect(promise).resolves.toEqual({ kind: 'dismissed' });
    expect(acceptTermsMock).not.toHaveBeenCalled();
  });

  it('passes through a getTermsStatus failure as accepted (server enforces on write)', async () => {
    getTermsStatusMock.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(ensureTermsAcceptedOutcome()).resolves.toEqual({ kind: 'accepted' });
    expect(alertCalls).toHaveLength(0);
  });
});
