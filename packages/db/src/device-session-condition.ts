import { sql, type SQL } from 'drizzle-orm';
import { device_sessions } from './schema';

/**
 * A usable device session has three parts: the row id, the account that owns
 * it, and an unset `revoked_at`. Every read that asks whether a session is
 * still usable applies the same three, so this is the one definition; a
 * caller that needs a narrower condition adds to it.
 *
 * Row locking is a call-site concern. The condition alone does not lock
 * anything, and a caller that must hold the row against a concurrent
 * revocation adds `FOR SHARE` to its own statement.
 */
export function liveDeviceSessionCondition(params: {
  deviceSessionId: string;
  userId: string;
}): SQL {
  return sql`${device_sessions.id} = ${params.deviceSessionId}
    AND ${device_sessions.kilo_user_id} = ${params.userId}
    AND ${device_sessions.revoked_at} IS NULL`;
}
