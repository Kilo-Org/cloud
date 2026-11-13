import { Platform } from 'react-native';

import { i18n } from '@/i18n';

import { sshPackage } from './native';
import { closeSession } from './session/manager';
import { live } from './session/live';

/**
 * Android keeps the sockets and the JS runtime alive with the foreground
 * service the package declares, so its notification needs the app's copy. iOS
 * has no such keepalive, where both calls only resolve.
 */
const BACKGROUND_SESSIONS = Platform.OS === 'android';

/**
 * Hands the background session notification its localized texts and answers its
 * `Disconnect all` action. Returns the teardown that stops listening.
 */
export function startSshBackgroundSessions(): () => void {
  if (!BACKGROUND_SESSIONS) {
    return () => undefined;
  }
  let cancelled = false;
  let removeListener: (() => void) | null = null;

  void (async () => {
    try {
      const ssh = await sshPackage();
      if (cancelled) {
        return;
      }
      ssh.configureBackgroundSessions({
        channelName: i18n.t('ssh.notification.channel'),
        title: i18n.t('ssh.notification.title'),
        body: count => i18n.t('ssh.notification.body', { sessions: count }),
        disconnectAllLabel: i18n.t('ssh.notification.disconnectAll'),
      });
      const subscription = ssh.addSshListener('onDisconnectAll', () => {
        void closeEverySession();
      });
      removeListener = () => {
        subscription.remove();
      };
    } catch {
      // A build without the module keeps its sessions in the foreground only.
    }
  })();

  return () => {
    cancelled = true;
    removeListener?.();
    removeListener = null;
  };
}

async function closeEverySession(): Promise<void> {
  for (const id of [...live.keys()]) {
    await closeSession(id);
  }
}
