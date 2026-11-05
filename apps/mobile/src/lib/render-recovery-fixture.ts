/**
 * Dev-only render-recovery fixture harness. A dev fixture link under
 * `dev/render-recovery-fixture/<name>` arms a fault for the fixture route
 * `/(app)/render-recovery-fixture`, so the authenticated stack's screen
 * recovery can be exercised on a build:
 *
 * - `transient` arms a fault that throws on every render of the route, then
 *   opens it. `clear` disarms without navigating, so the fallback's Retry can be
 *   pressed on the screen that is already showing.
 * - `payload` arms a fault that throws only while the route's organization
 *   payload names the marker, then opens it. A remount against the same cached
 *   payload throws again; `Retry` refetches the route's declared scope first, so
 *   it recovers once the backend row no longer carries the marker.
 *
 * The only entry point is `+native-intent.tsx`, behind `__DEV__`. The faults are
 * `E2eInjectedFaultError`s, so the Sentry `beforeSend` gate drops them instead
 * of filing a defect the product does not have.
 */

const FIXTURE_PATH = /(?:^|\/)dev\/render-recovery-fixture\/([\w-]+)\/?(?:[?#].*)?$/;

const RENDER_RECOVERY_FIXTURE_ROUTE = '/(app)/render-recovery-fixture';

/** The organization name that arms the payload fault. */
export const RENDER_RECOVERY_PAYLOAD_MARKER = 'Render recovery fault';

export type RenderRecoveryFault = 'none' | 'transient' | 'payload';

let fault: RenderRecoveryFault = 'none';
const listeners = new Set<() => void>();

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[render-recovery-fixture] ${message}`);
}

function setFault(next: RenderRecoveryFault): void {
  if (fault === next) {
    return;
  }
  fault = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getRenderRecoveryFault(): RenderRecoveryFault {
  return fault;
}

/**
 * The fixture screen subscribes, so arming a fault on a screen that is already
 * open re-renders it into the failure. That is the case the recovery exists
 * for: an active screen that fails while the person is on it.
 */
export function subscribeRenderRecoveryFault(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Handle a fixture link. Undefined when the path is not a fixture link; a route
 * to open for an arming link; null when the link only changed the fault, so the
 * caller returns falsy and the current screen stays where it is.
 */
export function handleRenderRecoveryFixturePath(path: string): string | null | undefined {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return undefined;
  }
  if (name === 'transient' || name === 'payload') {
    setFault(name);
    log(`armed ${name}`);
    return RENDER_RECOVERY_FIXTURE_ROUTE;
  }
  if (name === 'clear') {
    setFault('none');
    log('cleared');
    return null;
  }
  log(`unknown fixture ${name}`);
  return null;
}
