import { router } from 'expo-router';

import { writePendingExternalAuth } from '@/lib/auth/pending-external-auth';
import { API_BASE_URL } from '@/lib/config';

/**
 * Development-only entry for the sign-in screen's device-auth states. The
 * screen restores a browser sign-in that survived process death from the
 * pending record and polls the server with its device code. This fixture writes
 * that same record and opens the same screen, so the real restore and the real
 * poll produce each state from the local server's answer:
 *
 * - `pending`: the seeded pending request. The screen shows the code and the
 *   "Continuing sign-in" line, and the server keeps answering 202.
 * - `denied`: the seeded denied request. The first poll gets 403 and the screen
 *   shows the denied banner above the sign-in form.
 * - `expired`: a device code the server does not know. It answers 410 (a
 *   missing request reads as expired) and the screen shows the expired banner.
 * - `error`: an empty device code. The server refuses the body with 400 and the
 *   screen shows the error banner.
 *
 * Open it signed out: `pnpm dev:seed app:device-auth-states` (once per local
 * database, for `pending` and `denied`), then
 * `kiloapp:///dev/login-fixture/<pending|denied|expired|error>`. The first poll
 * runs a few seconds after the screen opens.
 */
const FIXTURE_PATH = /(?:^|\/)dev\/login-fixture\/(pending|denied|expired|error)\/?(?:[?#].*)?$/;

/** The device codes `dev/seed/app/device-auth-states.ts` stores; keep the two in step. */
const LOGIN_FIXTURE_DEVICE_CODES = {
  pending: 'dev-seed-device-auth-pending',
  denied: 'dev-seed-device-auth-denied',
  expired: 'dev-seed-device-auth-missing',
  error: '',
} as const;

const USER_CODE = 'DEVS-EED1';

export function handleLoginFixturePath(path: string): boolean {
  const match = FIXTURE_PATH.exec(path);
  const state = match?.[1];
  if (state !== 'pending' && state !== 'denied' && state !== 'expired' && state !== 'error') {
    return false;
  }
  void (async () => {
    // The record must be on disk before the screen mounts: its restore reads
    // the record once, on mount.
    await writePendingExternalAuth({
      deviceCode: LOGIN_FIXTURE_DEVICE_CODES[state],
      userCode: USER_CODE,
      verificationUrl: `${API_BASE_URL}/device-auth?code=${USER_CODE}`,
      startedAt: Date.now(),
    });
    router.replace('/(auth)/login');
  })();
  return true;
}
