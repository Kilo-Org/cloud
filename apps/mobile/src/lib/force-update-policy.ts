import * as z from 'zod';

import { isVersionBelow } from '@kilocode/app-shared/app-version';

export type ForceUpdateCheck = { ok: boolean; data: unknown };

type MinVersionBody = { ios: string; android: string };

const minVersionBodySchema = z.object({ ios: z.string(), android: z.string() });

function parseMinVersionBody(data: unknown): MinVersionBody | undefined {
  const result = minVersionBodySchema.safeParse(data);
  return result.success ? result.data : undefined;
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
