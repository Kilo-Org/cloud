import { useEffect } from 'react';

import { startSshReconnectTriggers } from '@/lib/ssh/session/reconnect-triggers';

/**
 * Brings a dropped session back when the app returns to the foreground or the
 * network does. It renders nothing and mounts once per signed-in app: a session
 * outlives the screen that opened it, so the trigger cannot live on that screen.
 */
export function SshSessionRuntime() {
  useEffect(() => startSshReconnectTriggers(), []);
  return null;
}
