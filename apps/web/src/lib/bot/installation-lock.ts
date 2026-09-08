import type { StateAdapter } from 'chat';

type InstallationLockState = Pick<StateAdapter, 'acquireLock' | 'extendLock' | 'releaseLock'>;

const LOCK_TTL_MS = 5 * 60_000;
const LOCK_HEARTBEAT_MS = 10_000;

export async function withChatInstallationLock<T>(
  state: InstallationLockState,
  platform: string,
  installationId: string,
  callback: () => Promise<T>
): Promise<T> {
  const lockKey = `oauth-installation:${platform}:${installationId}`;
  const deadline = Date.now() + 5_000;
  let lock = await state.acquireLock(lockKey, LOCK_TTL_MS);
  while (!lock && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    lock = await state.acquireLock(lockKey, LOCK_TTL_MS);
  }
  if (!lock) throw new Error(`${platform} installation is already being updated`);
  let stopHeartbeat: (() => void) | undefined;
  let heartbeatError: Error | undefined;
  const stopped = new Promise<void>(resolve => {
    stopHeartbeat = resolve;
  });
  const heartbeat = (async () => {
    while (true) {
      const result = await new Promise<'tick' | 'stopped'>(resolve => {
        const timer = setTimeout(() => resolve('tick'), LOCK_HEARTBEAT_MS);
        void stopped.then(() => {
          clearTimeout(timer);
          resolve('stopped');
        });
      });
      if (result === 'stopped') return;
      try {
        if (!(await state.extendLock(lock, LOCK_TTL_MS))) {
          heartbeatError = new Error(`${platform} installation lock lease was lost`);
          return;
        }
      } catch (error) {
        heartbeatError = error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  })();
  let result: T;
  try {
    result = await callback();
  } finally {
    stopHeartbeat?.();
    await heartbeat;
    await state.releaseLock(lock);
  }
  if (heartbeatError) throw heartbeatError;
  return result;
}
