import { type SshDatabase } from '../database';
import { findKnownHost } from '../known-hosts';

/** The host key a server offered, as the connecting request reports it. */
export type OfferedHostKey = {
  readonly hostPattern: string;
  readonly algorithm: string;
  readonly fingerprintSha256: string;
};

export type HostKeyVerdict =
  | { readonly kind: 'trusted' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'mismatch'; readonly knownFingerprintSha256: string };

/**
 * What the store says about an offered key. The comparison is per algorithm:
 * a server that starts offering a second key type is new for that type, while
 * a different key of a type the store already trusts is a changed host.
 */
export function judgeHostKey(db: SshDatabase, offered: OfferedHostKey): HostKeyVerdict {
  const known = findKnownHost(db, offered.hostPattern, offered.algorithm);
  if (known === null) {
    return { kind: 'unknown' };
  }
  return known.fingerprintSha256 === offered.fingerprintSha256
    ? { kind: 'trusted' }
    : { kind: 'mismatch', knownFingerprintSha256: known.fingerprintSha256 };
}
