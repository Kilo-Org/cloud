import { writePendingExternalAuth } from '@/lib/auth/pending-external-auth';
import { API_BASE_URL } from '@/lib/config';

/**
 * Development-only entry for the sign-in screen's device-auth states. The
 * screen restores a browser sign-in that survived process death from the
 * pending record and polls the server with its device code. This fixture writes
 * that same record, and `src/app/(auth)/login-fixture.tsx` mounts the real
 * `LoginScreen` only after the write landed, so the real restore and the real
 * poll produce each state from the local server's answer:
 *
 * - `pending`: the seeded pending request. The screen shows its code and the
 *   "Continuing sign-in" line, and the server keeps answering 202.
 * - `denied`: the seeded denied request. The first poll gets 403 and the screen
 *   shows the denied banner above the sign-in form.
 * - `expired`: a device code the server does not know. It answers 410 (a
 *   missing request reads as expired) and the screen shows the expired banner.
 * - `error`: an empty device code. The server refuses the body with 400 and the
 *   screen shows the error banner.
 *
 * The route is its own screen, pushed over the signed-out stack: a sign-in
 * screen already open keeps its mount, so its unmount cannot clear the record
 * this route's screen restores. It needs a signed-out app; a signed-in app is
 * sent out of `(auth)`, and the route writes nothing there.
 *
 * Open it signed out: `pnpm dev:seed app:device-auth-states` (once per local
 * database, for `pending` and `denied`), then
 * `kiloapp:///dev/login-fixture/<pending|denied|expired|error>`. The first poll
 * runs a few seconds after the screen opens.
 */
const FIXTURE_PATH = /(?:^|\/)dev\/login-fixture\/(pending|denied|expired|error)\/?(?:[?#].*)?$/;

const LOGIN_FIXTURE_STATES = ['pending', 'denied', 'expired', 'error'] as const;

type LoginFixtureState = (typeof LOGIN_FIXTURE_STATES)[number];

/**
 * The resumed sign-in of each state. `pending` and `denied` are the requests
 * `dev/seed/app/device-auth-states.ts` stores, device code and user code alike;
 * keep the two in step. The other two name no stored request.
 */
const LOGIN_FIXTURE_REQUESTS = {
  pending: { deviceCode: 'dev-seed-device-auth-pending', userCode: 'DEVP-ENDG' },
  denied: { deviceCode: 'dev-seed-device-auth-denied', userCode: 'DEVD-ENYD' },
  expired: { deviceCode: 'dev-seed-device-auth-missing', userCode: 'DEVX-PRDZ' },
  error: { deviceCode: '', userCode: 'DEVE-RRRR' },
} satisfies Record<LoginFixtureState, { deviceCode: string; userCode: string }>;

export function isLoginFixtureState(value: string): value is LoginFixtureState {
  return LOGIN_FIXTURE_STATES.some(state => state === value);
}

export function loginFixtureRoute(path: string): string | null {
  const state = FIXTURE_PATH.exec(path)?.[1];
  return state === undefined ? null : `/(auth)/login-fixture?state=${state}`;
}

/** Writes the state's resumed sign-in, as a browser sign-in in flight leaves it. */
export async function writeLoginFixture(state: LoginFixtureState): Promise<void> {
  const { deviceCode, userCode } = LOGIN_FIXTURE_REQUESTS[state];
  await writePendingExternalAuth({
    deviceCode,
    userCode,
    verificationUrl: `${API_BASE_URL}/device-auth?code=${userCode}`,
    startedAt: Date.now(),
  });
}
