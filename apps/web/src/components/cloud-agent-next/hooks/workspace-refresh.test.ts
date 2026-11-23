import { createWorkspaceRefreshCoordinator, WORKSPACE_REFRESH_DELAY_MS } from './workspace-refresh';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('coalesces workspace IDs and sends bounded batches after 300ms', async () => {
  const refresh = jest.fn(async (_ids: string[]) => {});
  const coordinator = createWorkspaceRefreshCoordinator(refresh, jest.fn());
  for (let index = 0; index < 401; index++) {
    coordinator.schedule(String(index));
    coordinator.schedule(String(index));
  }
  await jest.advanceTimersByTimeAsync(WORKSPACE_REFRESH_DELAY_MS - 1);
  expect(refresh).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(refresh.mock.calls.map(([ids]) => ids.length)).toEqual([200, 200, 1]);
  coordinator.dispose();
});

it('retains events received while a refresh is in progress', async () => {
  let finish: (() => void) | undefined;
  const refresh = jest.fn(async (_ids: string[]) => {
    await new Promise<void>(resolve => {
      finish = resolve;
    });
  });
  const coordinator = createWorkspaceRefreshCoordinator(refresh, jest.fn());
  coordinator.schedule('first');
  await jest.advanceTimersByTimeAsync(300);
  coordinator.schedule('second');
  finish?.();
  await jest.advanceTimersByTimeAsync(300);
  expect(refresh.mock.calls.map(([ids]) => ids)).toEqual([['first'], ['second']]);
  finish?.();
  coordinator.dispose();
});

it('cancels pending work on disposal and reports failures', async () => {
  const error = new Error('Unavailable');
  const onError = jest.fn();
  const refresh = jest.fn(async () => {
    throw error;
  });
  const coordinator = createWorkspaceRefreshCoordinator(refresh, onError);
  coordinator.schedule('first');
  await jest.advanceTimersByTimeAsync(300);
  expect(onError).toHaveBeenCalledWith(error, ['first']);
  coordinator.schedule('cancelled');
  coordinator.dispose();
  await jest.advanceTimersByTimeAsync(300);
  expect(refresh).toHaveBeenCalledTimes(1);
});
