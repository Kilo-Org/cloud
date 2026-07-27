import { useQuery } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';

import { createTestQueryClient, renderWithProviders, waitFor } from './render-with-providers';

// Representative mounted test: mounts a real React tree through the provider
// harness and asserts a TanStack Query transitions from pending to success,
// proving the harness renders, runs effects, and observes async state.
type Observed = {
  status: string;
  data: string | undefined;
};

function QueryConsumer({
  queryFn,
  onRender,
}: {
  queryFn: () => Promise<string>;
  onRender: (o: Observed) => void;
}) {
  const { data, status } = useQuery({ queryKey: ['harness-probe'], queryFn });
  onRender({ status, data });
  return null;
}

test('renderWithProviders mounts a QueryClient tree and resolves a query', async () => {
  const queryFn = vi.fn().mockResolvedValue('loaded');
  const queryClient = createTestQueryClient();
  const renders: Observed[] = [];
  const latest = (): Observed => {
    const last = renders.at(-1);
    if (!last) {
      throw new Error('component has not rendered yet');
    }
    return last;
  };

  const { unmount } = await renderWithProviders(
    <QueryConsumer
      queryFn={queryFn}
      onRender={o => {
        renders.push(o);
      }}
    />,
    { queryClient }
  );

  // Initial mount: query is pending, no data yet.
  expect(latest().status).toBe('pending');
  expect(latest().data).toBeUndefined();

  // Let the query settle, then assert the resolved state was rendered.
  await waitFor(() => latest().status === 'success');

  expect(latest().data).toBe('loaded');
  expect(queryFn).toHaveBeenCalledTimes(1);

  unmount();
});
