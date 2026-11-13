import { useEffect } from 'react';

import { startSshBackgroundSessions } from '@/lib/ssh/background';
import { startSshReconnectTriggers } from '@/lib/ssh/session/reconnect-triggers';

/**
 * Brings a dropped session back when the app returns to the foreground or the
 * network does, and hands the Android background session notification its copy.
 * It renders nothing and mounts once per signed-in app: a session outlives the
 * screen that opened it, so neither can live on that screen.
 */
export function SshSessionRuntime() {
  useEffect(() => startSshReconnectTriggers(), []);
  useEffect(() => startSshBackgroundSessions(), []);
  return null;
}
