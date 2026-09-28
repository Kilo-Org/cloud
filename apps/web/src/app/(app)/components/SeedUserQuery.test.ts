import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeedUserQuery } from './SeedUserQuery';

/**
 * The footer and the customer-source survey read `['user']` while React
 * hydrates; seeding it during render is what keeps the server and the first
 * client render in agreement. These assertions pin the seeding contract.
 */
function renderWithClient(user: unknown) {
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SeedUserQuery, { user }),
      React.createElement('span', null, 'app shell')
    )
  );
  return { queryClient, html };
}

describe('SeedUserQuery', () => {
  it('seeds the user query and renders nothing of its own', () => {
    const user = { id: 'user-1', google_user_email: 'seed@example.com' };
    const { queryClient, html } = renderWithClient(user);

    expect(html).toContain('app shell');
    expect(html).not.toContain('seed@example.com');
    expect(queryClient.getQueryData(['user'])).toEqual(user);
  });

  it('seeds null when nobody is signed in', () => {
    const { queryClient } = renderWithClient(null);

    expect(queryClient.getQueryData(['user'])).toBeNull();
  });
});
