import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@kilocode/db/schema';
import { device_sessions } from '@kilocode/db/schema';
import { getWorkerDb } from '@kilocode/db/client';
import { and, eq, isNull } from 'drizzle-orm';

import { deviceSessionIdSchema } from './device-session-claims.js';

export { deviceSessionIdSchema } from './device-session-claims.js';

export type DeviceSessionDb = Pick<NodePgDatabase<typeof schema>, 'select'>;

/**
 * A device access token is only valid while its session row still exists, is
 * owned by the token's user, and has not been revoked. Missing, foreign and
 * revoked rows are all refused; a query failure is allowed to propagate so
 * callers can keep an infrastructure outage distinct from a bad credential.
 */
export async function isActiveDeviceSession(
  fromDb: DeviceSessionDb,
  deviceSessionId: string,
  userId: string
): Promise<boolean> {
  if (!deviceSessionIdSchema.safeParse(deviceSessionId).success) return false;

  const rows = await fromDb
    .select({ id: device_sessions.id })
    .from(device_sessions)
    .where(
      and(
        eq(device_sessions.id, deviceSessionId),
        eq(device_sessions.kilo_user_id, userId),
        isNull(device_sessions.revoked_at)
      )
    )
    .limit(1);

  return rows.length === 1;
}

export async function findActiveDeviceSession(
  connectionString: string,
  deviceSessionId: string,
  userId: string
): Promise<boolean> {
  return isActiveDeviceSession(getWorkerDb(connectionString), deviceSessionId, userId);
}
