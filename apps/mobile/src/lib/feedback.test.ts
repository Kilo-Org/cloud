import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: posthogMock.captureEvent,
  FEEDBACK_SUBMITTED_EVENT: 'feedback_submitted',
}));

type AlertButton = { text: string; onPress?: () => void };

function pressRateKilo() {
  const firstAlert = alertMock.alert.mock.calls[0] as [string, string | undefined, AlertButton[]];
  firstAlert[2].find(button => button.text === 'I like it')?.onPress?.();

  const secondAlert = alertMock.alert.mock.calls[1] as [string, string | undefined, AlertButton[]];
  secondAlert[2].find(button => button.text === 'Rate Kilo')?.onPress?.();
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => {
    setImmediate(resolve);
  });
}

describe('feedback store-review write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // Alert calls: [0] and [1] are the two first-level prompts; pressing
    // "I like it" on each appends its second-level prompt at [2] and [3].
    const firstPromptOne = alertMock.alert.mock.calls[0] as [
      string,
      string | undefined,
      AlertButton[],
    ];
    const firstPromptTwo = alertMock.alert.mock.calls[1] as [
      string,
      string | undefined,
      AlertButton[],
    ];
    firstPromptOne[2].find(button => button.text === 'I like it')?.onPress?.();
    firstPromptTwo[2].find(button => button.text === 'I like it')?.onPress?.();

    const secondPromptOne = alertMock.alert.mock.calls[2] as [
      string,
      string | undefined,
      AlertButton[],
    ];
    const secondPromptTwo = alertMock.alert.mock.calls[3] as [
      string,
      string | undefined,
      AlertButton[],
    ];
    secondPromptOne[2].find(button => button.text === 'Rate Kilo')?.onPress?.();
    secondPromptTwo[2].find(button => button.text === 'Rate Kilo')?.onPress?.();

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
