import { afterEach, expect, it, vi } from 'vitest';

import { testEnv } from '../../test/helpers';
import { publishNotification } from './publish';
import type { SessionNotification } from './protocol';

afterEach(() => vi.restoreAllMocks());

it('keeps notification routing failure non-fatal and excludes raw errors from logs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const userID = 'synthetic-notification-owner';
  const event: SessionNotification = {
    version: 1,
    type: 'session.created',
    session: {
      sessionID: 'ses_synthetic',
      tenant: { type: 'user', id: userID },
      revision: 0,
      position: 0,
      status: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
    changedAt: 1,
  };
  const get = vi.spyOn(testEnv.SESSION_NOTIFICATIONS_DO, 'get').mockImplementation(() => {
    throw new Error('synthetic-private-error-content');
  });
  await expect(publishNotification(testEnv, userID, event)).resolves.toBeUndefined();
  expect(get).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('Session sync notification delivery failed', {
    type: 'session.created',
    errorClass: 'Error',
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-error-content');
});
