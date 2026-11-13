import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { sshPackage } from '../native';
import { useIdleNotify } from './idle-notify';
import { type SshSessionPhase } from './types';

/** How long a shell stays quiet before the notification counts it as finished. */
const QUIET_MS = 5000;

/**
 * Arms the one-shot "command finished" watch on the native shell while the
 * session asks for it. A reconnect opens a new shell, and the watch is armed
 * again for that one.
 */
export function useIdleNotifyArming(
  sessionId: string,
  shellId: string | null,
  phase: SshSessionPhase['kind'] | null
): void {
  const { t } = useTranslation();
  const enabled = useIdleNotify(sessionId);

  useEffect(() => {
    if (!enabled || shellId === null || phase !== 'connected') {
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ssh = await sshPackage();
        if (!cancelled) {
          ssh.notifyWhenIdle(shellId, QUIET_MS, { title: t('ssh.session.commandFinished') });
        }
      } catch {
        // A build without the module has no shell to watch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, shellId, phase, t]);
}
