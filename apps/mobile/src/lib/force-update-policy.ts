import { isVersionBelow } from '@kilocode/app-shared/app-version';

export type ForceUpdateCheck = { ok: boolean; data: unknown };

type MinVersionBody = { ios: string; android: string };

function parseMinVersionBody(data: unknown): MinVersionBody | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { ios, android } = data as { ios?: unknown; android?: unknown };
  if (typeof ios !== 'string' || typeof android !== 'string') {
    return undefined;
  }
  return { ios, android };
}

export type ForceUpdateState =
  | { kind: 'update-required' }
  | { kind: 'up-to-date' }
  | { kind: 'unknown' };

/**
 * Resolves the check to a three-way state. `update-required` only when the
 * response is ok, the native version is present, the body parses to
 * `{ ios, android }` (both strings), and the native version is below the
 * platform minimum. Fails open (`unknown`) on a non-ok response, a missing
 * native version, or a malformed body. `unknown` must not clear the server
 * signal; only `up-to-date` does.
 */
export function resolveForceUpdateState(
  response: ForceUpdateCheck,
  nativeVersion: string | null,
  platform: 'ios' | 'android'
): ForceUpdateState {
  if (!response.ok) {
    return { kind: 'unknown' };
  }
  if (!nativeVersion) {
    return { kind: 'unknown' };
  }
  const body = parseMinVersionBody(response.data);
  if (!body) {
    return { kind: 'unknown' };
  }
  const minimum = platform === 'ios' ? body.ios : body.android;
  if (isVersionBelow(nativeVersion, minimum)) {
    return { kind: 'update-required' };
  }
  return { kind: 'up-to-date' };
}
