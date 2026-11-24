import 'server-only';
import type { PrivilegedCredentialKind } from '@kilocode/web-shared/lib/admin/privileged-access';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Structured log line for a change to the passkeys an account can sign in
 * with, emitted for every account. It is stdout telemetry like
 * `admin_login_succeeded`, not a database table.
 *
 * Security: `passkeyId` is the `passkey_credentials` row id. Never add the
 * WebAuthn credential id, the public key, an email address, or any part of the
 * request's credential.
 */
export type PasskeyLifecycleEvent = {
  event: 'passkey_enrolled' | 'passkey_deleted';
  kiloUserId: string;
  passkeyId: string;
  /** How the request authenticated; null when its context carries no derived kind. */
  credential: PrivilegedCredentialKind | null;
};

export function logPasskeyLifecycleEvent(event: PasskeyLifecycleEvent): void {
  logExceptInTest(JSON.stringify(event));
}
