import { encryptedDatabase } from '@/lib/persist/encrypted-kv';
import { isProtectedDataAvailable, ProtectedDataUnavailableError } from '@/lib/protected-data';

import { type SqlValue, type SshDatabase } from './database';

/**
 * The device's encrypted database, in the shape the ssh stores query it with.
 *
 * Every screen reads and writes it on the JS thread through the synchronous
 * statements the stores use, so a query returns its rows rather than a promise
 * of them; only the open is asynchronous, and it is shared with the rest of the
 * app (`encryptedDatabase`).
 */
export async function sshDatabase(): Promise<SshDatabase> {
  const client = await encryptedDatabase();
  return {
    getAllSync: <T>(source: string, params: SqlValue[]): T[] => client.getAllSync<T>(source, ...params),
    runSync: (source: string, params: SqlValue[]) => {
      client.runSync(source, ...params);
    },
    withTransactionSync: (task: () => void) => {
      client.withTransactionSync(task);
    },
  };
}

/**
 * Why the on-device store would not open.
 *
 * `locked` is the device's keychain refusing while it is locked: the open waits
 * for unlock, so trying again is what recovers it. `unavailable` is a build
 * without SQLCipher or a database the app could not reopen, which trying again
 * cannot fix: the state says so and offers no Retry.
 */
export type SshStorageFailure = 'locked' | 'unavailable';

export function classifySshStorageFailure(error: unknown): SshStorageFailure {
  if (error instanceof ProtectedDataUnavailableError || !isProtectedDataAvailable()) {
    return 'locked';
  }
  return 'unavailable';
}
