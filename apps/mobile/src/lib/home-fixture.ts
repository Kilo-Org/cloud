/**
 * Dev-only Home fixture harness. `kiloapp:///dev/home-fixture/connection-lost`
 * makes `useUserWebConnectionHealth` report a lost user-web connection
 * (disconnected, reconnect exhausted), so the `Connection lost` notice paints
 * without breaking the real socket; `.../release` returns the live values. The
 * only entry point is `+native-intent.tsx`, behind `__DEV__`.
 */

const FIXTURE_PATH = /(?:^|\/)dev\/home-fixture\/([\w-]+)\/?(?:[?#].*)?$/;
const CONNECTION_LOST = 'connection-lost';
const RELEASE = 'release';

let connectionLost = false;
const listeners = new Set<() => void>();

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[home-fixture] ${message}`);
}

function setConnectionLost(next: boolean): void {
  if (connectionLost === next) {
    return;
  }
  connectionLost = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeHomeFixture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isHomeFixtureConnectionLost(): boolean {
  return connectionLost;
}

/**
 * Handle a fixture link. True when the path is a fixture link (handled, even
 * when the name is unknown), so the caller returns falsy and nothing navigates.
 */
export function handleHomeFixturePath(path: string): boolean {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === CONNECTION_LOST) {
    setConnectionLost(true);
    log('applied connection-lost');
  } else if (name === RELEASE) {
    setConnectionLost(false);
    log('released');
  } else {
    log(`unknown fixture ${name}`);
  }
  return true;
}
