/**
 * Classifies the user agent recorded on a `device_sessions` row so the client
 * can label a session without parsing the raw header itself.
 *
 * The `device_auth_request_id` column is NOT a CLI marker: the mobile app's own
 * browser sign-in sets it (see `lib/device-auth/device-auth.ts`), so the client
 * kind comes from the recorded user agent instead.
 */

export type DeviceSessionKind = 'app' | 'cli' | 'browser' | 'other';

export interface DeviceSessionClient {
  kind: DeviceSessionKind;
  /** Set only for `kind: 'app'`. */
  platform: 'android' | 'ios' | null;
  /** First product token, set only for `kind: 'other'`. */
  clientName: string | null;
}

const OTHER_UNKNOWN: DeviceSessionClient = { kind: 'other', platform: null, clientName: null };

/** `Kilo-Code/<version> (android)` — the header the mobile app sends. */
const APP_USER_AGENT = /^Kilo-Code\/[^\s(]*\s*\((android|ios)[;)]/i;
/** OkHttp's default header, recorded by pre-metadata app builds on Android. */
const OKHTTP_USER_AGENT = /^okhttp(?:[/\s]|$)/i;
/** `Kilo-Code/<version>` with no platform word — the CLI. */
const CLI_USER_AGENT = /^Kilo-Code(?:\/|$)/i;

export function classifyDeviceSessionClient(
  userAgent: string | null | undefined
): DeviceSessionClient {
  const trimmed = (userAgent ?? '').trim();
  if (trimmed === '') return OTHER_UNKNOWN;

  if (trimmed.startsWith('Mozilla/')) {
    return { kind: 'browser', platform: null, clientName: null };
  }

  if (OKHTTP_USER_AGENT.test(trimmed)) {
    return { kind: 'app', platform: 'android', clientName: null };
  }

  const appMatch = APP_USER_AGENT.exec(trimmed);
  if (appMatch) {
    return {
      kind: 'app',
      platform: appMatch[1].toLowerCase() === 'ios' ? 'ios' : 'android',
      clientName: null,
    };
  }

  if (CLI_USER_AGENT.test(trimmed)) {
    return { kind: 'cli', platform: null, clientName: null };
  }

  const [product] = trimmed.split(/[\s/]/);
  return { kind: 'other', platform: null, clientName: product ? product : null };
}
