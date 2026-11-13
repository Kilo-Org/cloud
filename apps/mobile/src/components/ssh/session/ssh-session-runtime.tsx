import { useEffect } from 'react';

import { startSshBackgroundSessions } from '@/lib/ssh/background';
import { rehydrateSshSessions } from '@/lib/ssh/session/rehydrate';
import { startSshReconnectTriggers } from '@/lib/ssh/session/reconnect-triggers';

/**
 * Brings a dropped session back when the app returns to the foreground or the
 * network does, hands the Android background session notification its copy, and
 * adopts whatever the native registry kept from a previous JavaScript runtime.
 * It renders nothing and mounts once per signed-in app: a session outlives the
 * screen that opened it, so neither can live on that screen.
 */
export function SshSessionRuntime() {
  useEffect(() => startSshReconnectTriggers(), []);
  useEffect(() => startSshBackgroundSessions(), []);
  useEffect(() => {
    void rehydrateSshSessions();
  }, []);
  return null;
}