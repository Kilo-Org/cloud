import { withDORetry } from '@kilocode/worker-utils';

import { getSessionNotificationsDOStub } from '../dos/SessionNotificationsDO';
import type { Env } from '../env';
import type { SessionNotification } from './protocol';

export async function publishNotification(
  env: Env,
  userID: string,
  event: SessionNotification
): Promise<void> {
  try {
    await withDORetry(
      () => getSessionNotificationsDOStub(env, userID),
      stub => stub.publish({ userID, event }),
      'SessionNotificationsDO.publish'
    );
  } catch (error) {
    console.error('Session sync notification delivery failed', {
      type: event.type,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
  }
}
