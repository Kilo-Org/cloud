import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createTRPCContext } from '@/lib/trpc/init';
import { PrefetchedOrganizations } from './PrefetchedOrganizations';

// The component relies on the automatic JSX runtime; jest's classic transform
// emits `React.createElement`, so expose React globally as the sibling
// `SidebarUserFooter.test.ts` does.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

jest.mock('@/lib/trpc/init', () => ({ createTRPCContext: jest.fn() }));
jest.mock('@/routers/root-router', () => ({ rootRouter: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@trpc/tanstack-react-query', () => ({
  createTRPCOptionsProxy: jest.fn(() => ({
    organizations: {
      list: { queryOptions: () => ({ queryKey: ['organizations'], queryFn: () => [] }) },
    },
  })),
}));

describe('PrefetchedOrganizations user seed', () => {
  it.each(['signed-in', 'signed-out', 'context-failed', 'org-prefetch-failed'] as const)(
    'only seeds a resolved user: %s',
    async state => {
      const user = { id: 'user-1' };
      const context = jest.mocked(createTRPCContext);
      if (state === 'context-failed')
        context.mockRejectedValueOnce(new Error('Transient context failure'));
      else
        context.mockResolvedValueOnce({ user: state === 'signed-out' ? null : user } as Awaited<
          ReturnType<typeof createTRPCContext>
        >);
      if (state === 'org-prefetch-failed') {
        jest.mocked(createTRPCOptionsProxy).mockImplementationOnce(() => {
          throw new Error('Organization prefetch failed');
        });
      }
      const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
      const tree = await PrefetchedOrganizations({
        children: React.createElement('span', null, 'app shell'),
      });
      const html = renderToStaticMarkup(
        React.createElement(QueryClientProvider, { client: queryClient }, tree)
      );
      expect(html).toContain('app shell');
      expect(queryClient.getQueryData(['user'])).toEqual(
        state === 'signed-in' || state === 'org-prefetch-failed' ? user : undefined
      );
      if (state === 'context-failed') {
        const fetchUser = jest.fn().mockResolvedValue(user);
        await expect(
          queryClient.fetchQuery({ queryKey: ['user'], queryFn: fetchUser })
        ).resolves.toEqual(user);
        expect(fetchUser).toHaveBeenCalledTimes(1);
      }
      queryClient.clear();
    }
  );
});
