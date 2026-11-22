import { QueryObserver } from '@tanstack/react-query';
import { act, type ComponentProps } from 'react';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewReconnectNotice } from './pr-review-reconnect-notice';

const mocks = vi.hoisted(() => ({
  authorization: vi.fn<() => Promise<{ connected: boolean; revoked: boolean }>>(),
  review: vi.fn<() => Promise<string>>(),
  toastError: vi.fn(),
}));
const authorizationKey = ['githubApps', 'getUserAuthorization'];
const reviewKey = ['githubPrReview', 'getPullRequest'];

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // `Card` reaches `@/lib/utils` and therefore the app's i18n singleton, which
  // registers this plugin on load.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: {
        queryOptions: () => ({
          queryKey: authorizationKey,
          queryFn: mocks.authorization,
          staleTime: Infinity,
        }),
      },
    },
    githubPrReview: { pathFilter: () => ({ queryKey: ['githubPrReview'] }) },
  }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
let client = createTestQueryClient();
let unsubscribe: (() => void) | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  client = createTestQueryClient();
  client.setQueryData(authorizationKey, { connected: true, revoked: false });
  mocks.authorization.mockResolvedValue({ connected: true, revoked: false });
  mocks.review.mockResolvedValue('recovered');
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  client.clear();
});

async function mountNotice(
  props: ComponentProps<typeof PrReviewReconnectNotice> = {}
): Promise<void> {
  const observer = new QueryObserver(client, {
    queryKey: reviewKey,
    queryFn: mocks.review,
    staleTime: Infinity,
    initialData: 'cached',
  });
  unsubscribe = observer.subscribe(vi.fn<() => void>());
  view = await renderWithProviders(<PrReviewReconnectNotice {...props} />, {
    queryClient: client,
  });
}

function button() {
  const result = view?.renderer.root.find(node => (node.type as string) === 'Button');
  if (!result) {
    throw new Error('Connection button not found');
  }
  return result.props as { onPress: () => void; loading: boolean };
}

async function checkConnection() {
  await act(async () => {
    button().onPress();
    await Promise.resolve();
  });
  await waitFor(() => !button().loading && client.isMutating() === 0);
}

describe('PrReviewReconnectNotice', () => {
  it('checks fresh authorization and refetches review queries when still connected', async () => {
    await mountNotice();
    await checkConnection();

    expect(mocks.authorization).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(client.getQueryData(reviewKey)).toBe('recovered');
  });

  it('updates the authorization gate without retrying reviews when revoked', async () => {
    mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
    await mountNotice();
    await checkConnection();

    expect(client.getQueryData(authorizationKey)).toEqual({ connected: false, revoked: true });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('shows a failed connection check without retrying review queries', async () => {
    mocks.authorization.mockRejectedValue(new Error('Connection check failed'));
    await mountNotice();
    await checkConnection();

    expect(mocks.toastError).toHaveBeenCalledWith('Connection check failed');
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('shows progress until the connection check finishes', async () => {
    const authorization = Promise.withResolvers<{ connected: boolean; revoked: boolean }>();
    mocks.authorization.mockReturnValue(authorization.promise);
    await mountNotice();
    await act(async () => {
      button().onPress();
      await Promise.resolve();
    });
    await waitFor(() => button().loading);

    await act(async () => {
      authorization.resolve({ connected: true, revoked: false });
      await authorization.promise;
    });
    await waitFor(() => !button().loading);
    expect(mocks.review).toHaveBeenCalledOnce();
  });

  it('reports a check that settled on a usable connection', async () => {
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    // The answer is what a surface clears its own latch with, so it is
    // reported exactly once, after the check settled.
    expect(onConnectionRestored).toHaveBeenCalledOnce();
  });

  it('reports nothing when the check answers a revoked connection', async () => {
    mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    expect(onConnectionRestored).not.toHaveBeenCalled();
  });

  it('reports nothing when the check rejects', async () => {
    mocks.authorization.mockRejectedValue(new Error('Connection check failed'));
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    // The hook's toast owns the failure; a surface must not read a failed
    // check as a resolved connection.
    expect(mocks.toastError).toHaveBeenCalledWith('Connection check failed');
    expect(onConnectionRestored).not.toHaveBeenCalled();
  });
});
