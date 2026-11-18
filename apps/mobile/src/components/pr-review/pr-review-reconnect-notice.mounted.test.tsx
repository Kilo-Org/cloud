import { QueryObserver } from '@tanstack/react-query';
import { act, createElement } from 'react';
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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

async function mountNotice() {
  const observer = new QueryObserver(client, {
    queryKey: reviewKey,
    queryFn: mocks.review,
    staleTime: Infinity,
    initialData: 'cached',
  });
  unsubscribe = observer.subscribe(vi.fn<() => void>());
  view = await renderWithProviders(createElement(PrReviewReconnectNotice), { queryClient: client });
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
});
