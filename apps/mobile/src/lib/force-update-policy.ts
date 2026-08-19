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

/**
 * True (update required) only when the response is ok, the native version is
 * present, the body parses to `{ ios, android }` (both strings), and the native
 * version is below the platform minimum. Fails open (false) on a non-ok
 * response, a missing native version, or a malformed body.
 */
export function resolveForceUpdateState(
  response: ForceUpdateCheck,
  nativeVersion: string | null,
  platform: 'ios' | 'android'
): boolean {
  if (!response.ok || !nativeVersion) {
    return false;
  }
  const body = parseMinVersionBody(response.data);
  if (!body) {
    return false;
  }
  const minimum = platform === 'ios' ? body.ios : body.android;
  return isVersionBelow(nativeVersion, minimum);
}
