import type { User } from '@kilocode/db/schema';
import { createCloudAgentControlToken } from './request-control-token';

const mockIssue = jest.fn();
jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: (...args: unknown[]) => mockIssue(...args),
}));

beforeEach(() => {
  mockIssue.mockReset().mockResolvedValue({ token: 'test-control-token' });
});

it('coalesces concurrent calls only within the same request and authenticated user', async () => {
  const user = { id: 'oauth/user' } as User;
  const headers = new Headers();
  const first = createCloudAgentControlToken(user, headers);
  expect(createCloudAgentControlToken(user, headers)).toBe(first);
  await expect(first).resolves.toBe('test-control-token');
  await createCloudAgentControlToken(user, new Headers());
  await createCloudAgentControlToken({ ...user, id: 'other' }, headers);
  expect(mockIssue).toHaveBeenCalledTimes(3);
});

it('does not cache without request headers, or cache a failure', async () => {
  const user = { id: 'oauth/user' } as User;
  const headers = new Headers();
  mockIssue.mockRejectedValueOnce(new Error('temporarily unavailable'));
  await expect(createCloudAgentControlToken(user, headers)).rejects.toThrow(
    'temporarily unavailable'
  );
  await createCloudAgentControlToken(user, headers);
  await createCloudAgentControlToken(user);
  await createCloudAgentControlToken(user);
  expect(mockIssue).toHaveBeenCalledTimes(4);
});
