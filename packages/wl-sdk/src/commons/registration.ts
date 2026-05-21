/**
 * Rig registration DML.
 *
 * Port of `BuildRegistrationSQL` (commons/registration.go:7). Generates
 * the `INSERT … ON DUPLICATE KEY UPDATE` statement that registers a
 * new rig (or refreshes its metadata) on a wasteland's `rigs` table.
 *
 * Kept hand-written rather than auto-generated because the source
 * helper itself is hand-written in Go — the schema generator emits
 * pure CRUD DML, not the join-flow specifics that go through
 * `ON DUPLICATE KEY UPDATE`.
 */

import { escapeSqlString } from './escape';

export type RegistrationInput = {
  handle: string;
  /** DoltHub username/org that owns the rig's fork. */
  dolthubOrg: string;
  /** Human-readable name shown in UIs. */
  displayName: string;
  /** The rig owner's email (used to seed `hop_uri`). */
  ownerEmail: string;
  /** SDK / wl-sdk version string written to `gt_version`. */
  version: string;
};

/**
 * Build the registration SQL. Mirrors the Go reference byte-for-byte
 * up to whitespace and quote ordering — enough for the `wanted` row
 * comparison logic in tests, and bytewise compatible with what
 * existing wastelands accept.
 */
export function buildRegistrationDML(input: RegistrationInput): string {
  const { handle, dolthubOrg, displayName, ownerEmail, version } = input;
  const hopUri = `hop://${ownerEmail}/${handle}/`;

  const h = escapeSqlString(handle);
  const dn = escapeSqlString(displayName);
  const org = escapeSqlString(dolthubOrg);
  const hu = escapeSqlString(hopUri);
  const oe = escapeSqlString(ownerEmail);
  const v = escapeSqlString(version);

  return (
    `INSERT INTO rigs (handle, display_name, dolthub_org, hop_uri, owner_email, gt_version, trust_level, registered_at, last_seen) ` +
    `VALUES ('${h}', '${dn}', '${org}', '${hu}', '${oe}', '${v}', 1, NOW(), NOW()) ` +
    `ON DUPLICATE KEY UPDATE display_name = '${dn}', dolthub_org = '${org}', hop_uri = '${hu}', owner_email = '${oe}', gt_version = '${v}', last_seen = NOW()`
  );
}
