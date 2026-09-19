import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/nextjs';
import { createTRPCContext } from '@/lib/trpc/init';
import { PrefetchedOrganizations } from './PrefetchedOrganizations';

Object.assign(globalThis, { React });

jest.mock('@/lib/trpc/init', () => ({ createTRPCContext: jest.fn() }));
jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@trpc/tanstack-react-query', () => ({
  createTRPCOptionsProxy: () => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations'], queryFn: async () => [] }) },
    },
  }),
}));

const user = { id: 'oauth/test', google_user_email: 'test@example.com' };

async function renderPrefetch() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
  const content = await PrefetchedOrganizations({ children: 'app shell' });
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, content));
  expect(html).toContain('app shell');
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('does not seed a signed-out user after context failure and allows immediate client recovery', async () => {
  const error = new Error('Transient context failure');
  jest.mocked(createTRPCContext).mockRejectedValue(error);
  const client = await renderPrefetch();
  expect(Sentry.captureException).toHaveBeenCalledWith(error);
  expect(client.getQueryState(['user'])).toBeUndefined();
  const fetchUser = jest.fn(async () => user);
  expect(await client.fetchQuery({ queryKey: ['user'], queryFn: fetchUser })).toEqual(user);
  expect(fetchUser).toHaveBeenCalledTimes(1);
});

it.each([user, null])('only seeds a successfully resolved non-null user: %j', async resolved => {
  jest
    .mocked(createTRPCContext)
    .mockResolvedValue({ user: resolved } as Awaited<ReturnType<typeof createTRPCContext>>);
  const client = await renderPrefetch();
  expect(client.getQueryData(['user'])).toEqual(resolved ?? undefined);
});
