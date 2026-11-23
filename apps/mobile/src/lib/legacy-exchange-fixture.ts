/**
 * Dev-only legacy-session fixture. `kiloapp:///dev/legacy-exchange-fixture/seed
 * ?token=<stored access token>` writes what a build from before the token pair
 * left behind: an access token in the keychain, no refresh token, no expiry and
 * no `auth-legacy-exchange-done` marker. That is the exact state
 * `exchangeLegacyToken()` branches on at cold start, so relaunching the app
 * after the seed runs the real exchange against the backend. `.../clear` drops
 * those four keys again, leaving a signed-out keychain.
 *
 * The only entry point is `+native-intent.tsx`, behind `__DEV__`. The `token`
 * value is a credential: it is written to the keychain and never logged, and
 * neither is a stored value that a failure report might quote.
 */

import * as SecureStore from '@/lib/auth/secure-store';
import {
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';

const FIXTURE_PATH = /(?:^|\/)dev\/legacy-exchange-fixture\/([\w-]+)(?:\?([^#]*))?(?:[?#].*)?$/;
const SEED = 'seed';
const CLEAR = 'clear';

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[legacy-exchange-fixture] ${message}`);
}

/** The `token` query parameter, decoded; empty when it is absent. */
function tokenFromQuery(query: string | undefined): string {
  const field = query?.split('&').find(candidate => candidate.startsWith('token='));
  if (field === undefined) {
    return '';
  }
  try {
    return decodeURIComponent(field.slice('token='.length).replaceAll('+', ' '));
  } catch {
    return '';
  }
}

/** The legacy session: token present, and nothing the completed exchange leaves. */
async function seed(token: string): Promise<void> {
  if (token === '') {
    log('seed skipped: no token');
    return;
  }
  // The token goes in first, so a refusing delete leaves the app in the state
  // the exchange reads — a stored token with no refresh token — rather than a
  // half-cleared session that would skip the exchange.
  await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY);
  await SecureStore.deleteItemAsync(LEGACY_EXCHANGE_DONE_KEY);
  log('seeded a legacy session; relaunch the app to run the exchange');
}

async function clear(): Promise<void> {
  await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(TOKEN_EXPIRES_AT_KEY);
  await SecureStore.deleteItemAsync(LEGACY_EXCHANGE_DONE_KEY);
  log('cleared');
}

/** Run the keychain work behind the link and report a failure without its value. */
async function run(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    log(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Handle a fixture link. True when the path is a fixture link (handled, even
 * when the name is unknown), so the caller returns falsy and nothing navigates.
 * The keychain work outlives the call: the resolver that reads the return value
 * cannot be asynchronous, so the write finishes on its own and failure is a log
 * line in Metro.
 */
export function handleLegacyExchangeFixturePath(path: string): boolean {
  const match = FIXTURE_PATH.exec(path);
  const name = match?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === SEED) {
    void run(() => seed(tokenFromQuery(match?.[2])));
  } else if (name === CLEAR) {
    void run(clear);
  } else {
    log(`unknown fixture ${name}`);
  }
  return true;
}
