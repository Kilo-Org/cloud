import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

const secureStoreMock = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
const storeReviewMock = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  requestReview: vi.fn(),
}));
const alertMock = vi.hoisted(() => ({ alert: vi.fn() }));
const linkingMock = vi.hoisted(() => ({ openURL: vi.fn() }));
const posthogMock = vi.hoisted(() => ({ captureEvent: vi.fn() }));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.0',
  nativeBuildVersion: '1',
}));
vi.mock('expo-secure-store', () => secureStoreMock);
vi.mock('expo-store-review', () => storeReviewMock);
vi.mock('react-native', () => ({
  Alert: alertMock,
  Linking: linkingMock,
  Platform: { OS: 'ios', select: (variants: Record<string, unknown>) => variants.ios },
}));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: posthogMock.captureEvent,
  FEEDBACK_SUBMITTED_EVENT: 'feedback_submitted',
}));

type AlertButton = { text: string; onPress?: () => void };

function alertTitle(index: number): string {
  const call = alertMock.alert.mock.calls[index] as [string, string | undefined, AlertButton[]];
  return call[0];
}

function alertButtons(index: number): AlertButton[] {
  const call = alertMock.alert.mock.calls[index] as [string, string | undefined, AlertButton[]];
  return call[2];
}

function pressButton(index: number, label: string) {
  alertButtons(index)
    .find(button => button.text === label)
    ?.onPress?.();
}

function pressRateKilo(index = 0) {
  pressButton(index, 'Rate the app');
}

function pressSendFeedback(index = 0) {
  pressButton(index, 'Send feedback');
}

function pressNotNow(index = 0) {
  pressButton(index, 'Not now');
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('feedback store-review write', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('shows the neutral prompt with the expected title and button order', async () => {
    const { showFeedbackPrompt } = await import('./feedback');

    showFeedbackPrompt('user-1');

    expect(alertTitle(0)).toBe('Rate the Kilo app');
    expect(alertButtons(0).map(button => button.text)).toEqual([
      'Not now',
      'Rate the app',
      'Send feedback',
    ]);
  });

  it('logs nothing when Not now is pressed', async () => {
    const { showFeedbackPrompt } = await import('./feedback');

    showFeedbackPrompt('user-1');
    pressNotNow();

    expect(posthogMock.captureEvent).not.toHaveBeenCalled();
    expect(storeReviewMock.requestReview).not.toHaveBeenCalled();
    expect(linkingMock.openURL).not.toHaveBeenCalled();
  });

  it('persists the review-requested timestamp through the shared metadata write', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue(null);
    storeReviewMock.isAvailableAsync.mockResolvedValue(true);
    storeReviewMock.requestReview.mockResolvedValue(undefined);

    showFeedbackPrompt('user-1');
    pressRateKilo();

    await vi.waitFor(() => {
      expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
        'store-review-requested-at',
        expect.any(String)
      );
    });
    expect(storeReviewMock.requestReview).toHaveBeenCalledOnce();
    expect(linkingMock.openURL).not.toHaveBeenCalled();
    expect(posthogMock.captureEvent).toHaveBeenCalledWith('feedback_submitted', {
      sentiment: 'positive',
    });
  });

  it('skips the write and the native prompt when a review was already requested', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue('2024-01-01T00:00:00.000Z');
    linkingMock.openURL.mockResolvedValue(undefined);

    showFeedbackPrompt('user-1');
    pressRateKilo();

    await flushMicrotasks();
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled();
    expect(storeReviewMock.requestReview).not.toHaveBeenCalled();
    expect(linkingMock.openURL).toHaveBeenCalledOnce();
  });

  it('falls through to the store page when persisting the timestamp fails', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue(null);
    storeReviewMock.isAvailableAsync.mockResolvedValue(true);
    secureStoreMock.setItemAsync.mockRejectedValue(new Error('secure store down'));
    linkingMock.openURL.mockResolvedValue(undefined);

    showFeedbackPrompt('user-1');
    pressRateKilo();

    await vi.waitFor(() => {
      expect(linkingMock.openURL).toHaveBeenCalledOnce();
    });
    expect(storeReviewMock.requestReview).not.toHaveBeenCalled();
  });

  it('shows the could-not-open-store toast when the store page cannot open', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue('2024-01-01T00:00:00.000Z');
    linkingMock.openURL.mockRejectedValue(new Error('no handler'));

    showFeedbackPrompt('user-1');
    pressRateKilo();

    await vi.waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(i18n.t('feedback.couldNotOpenStore'));
    });
  });

  it('logs negative sentiment and opens the mail app when Send feedback is pressed', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    linkingMock.openURL.mockResolvedValue(undefined);

    showFeedbackPrompt('user-1');
    pressSendFeedback();

    await flushMicrotasks();
    expect(posthogMock.captureEvent).toHaveBeenCalledWith('feedback_submitted', {
      sentiment: 'negative',
    });
    expect(linkingMock.openURL).toHaveBeenCalledWith(expect.stringContaining('mailto:'));
  });

  it('shows the no-email toast when the mail app cannot open', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    linkingMock.openURL.mockRejectedValue(new Error('no handler'));

    showFeedbackPrompt('user-1');
    pressSendFeedback();

    await vi.waitFor(() => {
      expect(posthogMock.captureEvent).toHaveBeenCalledWith('feedback_submitted', {
        sentiment: 'negative',
      });
      expect(toastMock.error).toHaveBeenCalledWith(
        i18n.t('feedback.noEmailApp', { email: 'hi@kilo.ai' })
      );
    });
  });

  it('writes the last-asked marker and defers the store review until Rate is pressed', async () => {
    const { maybeAskAfterSuccessfulOutcome } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue(null);
    storeReviewMock.isAvailableAsync.mockResolvedValue(true);
    storeReviewMock.requestReview.mockResolvedValue(undefined);

    await maybeAskAfterSuccessfulOutcome('user-1');

    expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
      'feedback-last-asked-at',
      expect.any(String)
    );
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalledWith(
      'store-review-requested-at',
      expect.any(String)
    );

    pressRateKilo();
    await vi.waitFor(() => {
      expect(secureStoreMock.setItemAsync).toHaveBeenCalledWith(
        'store-review-requested-at',
        expect.any(String)
      );
    });
  });

  it('skips the prompt when it was already asked', async () => {
    const { maybeAskAfterSuccessfulOutcome } = await import('./feedback');
    let lastAskedAt: string | null = null;
    secureStoreMock.getItemAsync.mockImplementation((key: string) => {
      if (key === 'feedback-last-asked-at') {
        return lastAskedAt;
      }
      return null;
    });
    secureStoreMock.setItemAsync.mockImplementation((key: string, value: string) => {
      if (key === 'feedback-last-asked-at') {
        lastAskedAt = value;
      }
    });

    await maybeAskAfterSuccessfulOutcome('user-1');
    expect(alertMock.alert).toHaveBeenCalledOnce();

    await maybeAskAfterSuccessfulOutcome('user-1');
    expect(alertMock.alert).toHaveBeenCalledOnce();
  });

  it('showFeedbackPrompt still alerts when the last-asked marker is set', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    secureStoreMock.getItemAsync.mockResolvedValue('2024-01-01T00:00:00.000Z');

    showFeedbackPrompt('user-1');

    expect(alertMock.alert).toHaveBeenCalledOnce();
    expect(alertTitle(0)).toBe('Rate the Kilo app');
  });

  it('triggers at most one native review when rateApp runs concurrently', async () => {
    const { showFeedbackPrompt } = await import('./feedback');
    const { chainSave } = await import('@/lib/hooks/save-chain');
    let releaseBlocker: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseBlocker = resolve;
    });
    let reviewRequestedAt: string | null = null;
    secureStoreMock.getItemAsync.mockImplementation((key: string) => {
      if (key === 'store-review-requested-at') {
        return reviewRequestedAt;
      }
      return null;
    });
    secureStoreMock.setItemAsync.mockImplementation((key: string, value: string) => {
      if (key === 'store-review-requested-at') {
        reviewRequestedAt = value;
      }
    });
    storeReviewMock.isAvailableAsync.mockResolvedValue(true);
    storeReviewMock.requestReview.mockResolvedValue(undefined);
    linkingMock.openURL.mockResolvedValue(undefined);

    // Hold the marker chain open so both review attempts queue behind it: the
    // check-and-mark runs inside one serialized operation, so only the first
    // call claims the native prompt and the second falls back to the store.
    const blocker = chainSave('store-review-requested-at', async () => {
      await gate;
    });
    showFeedbackPrompt('user-1');
    showFeedbackPrompt('user-1');
    pressRateKilo(0);
    pressRateKilo(1);

    await flushMicrotasks();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseBlocker!();

    await vi.waitFor(() => {
      expect(storeReviewMock.requestReview).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(linkingMock.openURL).toHaveBeenCalledOnce();
    });
    await blocker;
  });
});
