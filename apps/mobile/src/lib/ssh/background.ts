import { i18n } from '@/i18n';

import { type Cancellation } from './cancellation';
import { sshPackage } from './native';
import { closeSession } from './session/manager';
import { live } from './session/live';

/**
 * Hands the background session notification its localized texts and answers its
 * `Disconnect all` action. Android keeps the sockets and the JS runtime alive
 * with the foreground service the package declares; on iOS both calls only
 * resolve. Returns the teardown that stops listening.
 */
export function startSshBackgroundSessions(): () => void {
  const registration: Cancellation = { cancelled: false };
  let removeListener: (() => void) | null = null;

  void (async () => {
    try {
      const ssh = await sshPackage();
      if (registration.cancelled) {
        return;
      }
      ssh.configureBackgroundSessions({
        channelName: i18n.t('ssh.notification.sessions'),
        title: i18n.t('ssh.notification.sessions'),
        // The count is a token, not a number: the native side substitutes its
        // own registry count, so a reload cannot leave a stale number behind.
        bodyTemplate: i18n.t('ssh.notification.body', {
          sessions: ssh.BACKGROUND_SESSION_COUNT_TOKEN,
        }),
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
    registration.cancelled = true;
    removeListener?.();
    removeListener = null;
  };
}

async function closeEverySession(): Promise<void> {
  await Promise.all([...live.keys()].map(id => closeSession(id)));
}
