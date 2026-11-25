jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/notifications', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/notifications'),
  generateUserNotifications: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { generateUserNotifications } from '@/lib/notifications';
import { GET } from './route';

const auth = jest.mocked(getUserFromAuth);
const generate = jest.mocked(generateUserNotifications);

const request = () => new NextRequest('http://localhost/api/users/notifications');

afterEach(() => {
  jest.clearAllMocks();
});

it('returns a reauthenticate notification when authentication fails', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-25T23:59:00Z') });
  auth.mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json(failureResult('Invalid API token'), { status: 401 }),
    credentialsRejected: true,
  });

  const response = await GET(request());
  jest.useRealTimers();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    notifications: [
      {
        id: 'reauthenticate-2026-11-25',
        title: 'Authentication failed',
        message: 'Please reauthenticate to Kilo.',
      },
    ],
  });
  expect(generate).not.toHaveBeenCalled();
});

it('passes through authorization refusals', async () => {
  auth.mockResolvedValue({
    user: null,
    authFailedResponse: NextResponse.json(failureResult('Access denied (R1)'), { status: 403 }),
    authorizationRefused: true,
  });

  const response = await GET(request());

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ success: false, error: 'Access denied (R1)' });
});

it('returns the user notifications when authenticated', async () => {
  const user = defineTestUser();
  auth.mockResolvedValue({ user, authFailedResponse: null });
  const notification = { id: 'example', title: 'Example', message: 'Hello' };
  generate.mockResolvedValue([notification]);

  const response = await GET(request());

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ notifications: [notification] });
  expect(generate).toHaveBeenCalledWith(user, { isLegacyExtension: false });
});
