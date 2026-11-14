import { beforeEach, expect, it, vi } from 'vitest';

import { type SshForward } from './forwards';
import {
  adoptForwards,
  forwardsSnapshot,
  resetSessionForwards,
  startForward,
  stopForwardEverywhere,
} from './forwards-runtime';

vi.mock('@/lib/analytics/posthog', () => ({ captureEvent: vi.fn() }));

const native = vi.hoisted(() => ({ stopForwardById: vi.fn(), startLocalForward: vi.fn() }));
vi.mock('./native', () => ({
  sshPackage: () => Promise.resolve(native),
  nativeErrorCode: () => null,
}));

beforeEach(async () => {
  await Promise.all([...forwardsSnapshot().keys()].map(id => resetSessionForwards(id)));
  vi.clearAllMocks();
});

it('stops a deleted forward on every live session for its host', async () => {
  adoptForwards('a', 'native-a', [{ forwardId: 'row', nativeForwardId: 'listener-a', port: 8080 }]);
  adoptForwards('b', 'native-b', [{ forwardId: 'row', nativeForwardId: 'listener-b', port: 8081 }]);
  await stopForwardEverywhere('row');
  expect(native.stopForwardById.mock.calls).toEqual([['listener-a'], ['listener-b']]);
  expect(forwardsSnapshot().get('a')?.get('row')?.kind).toBe('stopped');
  expect(forwardsSnapshot().get('b')?.get('row')?.kind).toBe('stopped');
});

it('stops a listener that finishes starting after its row was deleted', async () => {
  const opening = Promise.withResolvers<{ port: number; stop: () => Promise<void> }>();
  native.startLocalForward.mockReturnValueOnce(opening.promise);
  const forward: SshForward = {
    id: 'row',
    hostId: 'host',
    direction: 'local',
    bindHost: '127.0.0.1',
    bindPort: 8080,
    destinationHost: 'localhost',
    destinationPort: 80,
    autoStart: false,
    label: null,
  };
  const started = startForward('a', 'native-a', forward);
  await vi.waitFor(() => {
    expect(native.startLocalForward).toHaveBeenCalled();
  });
  await stopForwardEverywhere('row');
  const stop = vi.fn().mockResolvedValue(undefined);
  opening.resolve({ port: 8080, stop });
  await started;
  expect(stop).toHaveBeenCalledOnce();
  expect(forwardsSnapshot().get('a')?.get('row')?.kind).toBe('stopped');
});
