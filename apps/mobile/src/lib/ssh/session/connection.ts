import { resetSessionForwards } from '../forwards-runtime';
import { sshPackage } from '../native';
import { type LiveSession } from './live';
import { patchSession, sessionById } from './session-store';

/** Lets go of the shell and the native connection an attempt had open. */
export function releaseShell(entry: LiveSession): void {
  const nativeIds = [...entry.jumpSessionIds];
  if (entry.nativeSessionId !== null) {
    nativeIds.push(entry.nativeSessionId);
  }
  entry.nativeSessionId = null;
  entry.jumpSessionIds = [];
  void disconnectAll(nativeIds);
  const session = sessionById(entry.id);
  const shellId = session?.shellId ?? null;
  if (shellId !== null) {
    void closeShellQuietly(shellId);
  }
  if (session !== null && (session.shellId !== null || session.pendingCommand !== null)) {
    patchSession(entry.id, { shellId: null, pendingCommand: null });
  }
  patchSession(entry.id, { nativeSessionId: null });
  void resetSessionForwards(entry.id);
}

async function closeShellQuietly(shellId: string): Promise<void> {
  try {
    const ssh = await sshPackage();
    ssh.closeShell(shellId);
  } catch {
    // The shell already ended, or this build carries no module: nothing is
    // left to release.
  }
}

/** Closes the hop sessions an abandoned attempt opened, outermost last. */
export async function disconnectAll(sessionIds: readonly string[]): Promise<void> {
  await Promise.all(sessionIds.toReversed().map(sessionId => forgetSession(sessionId)));
}

/**
 * Releases a native session the app no longer renders. A session left in the
 * core's registry keeps the connection state its host's next attempt waits on.
 */
export async function forgetSession(nativeSessionId: string): Promise<void> {
  try {
    const ssh = await sshPackage();
    await ssh.disconnect(nativeSessionId);
  } catch {
    // The screen that owned this connection is gone, so its resources are too.
  }
}
