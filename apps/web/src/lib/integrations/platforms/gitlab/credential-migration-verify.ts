import 'server-only';

import { getGitLabCredentialEncryptionPublicKeyInfo } from './credential-encryption';
import { requestGitLabCredentialPrivateAudit } from './credential-private-audit-client';

type KeyInfo = { keyId: string; publicKeySha256: string };

export type GitLabDecryptabilityBatch = {
  /** The web app's active public key equals the private key held by the git-token service. */
  keyMatches: boolean;
  activeKey: KeyInfo | null;
  webKey: KeyInfo;
  counts: {
    credentials: number;
    secrets: number;
    passedCredentials: number;
    profileFailures: number;
    configurationFailures: number;
    parseFailures: number;
    unknownKeyFailures: number;
    decryptOrAadFailures: number;
  };
  failing: {
    profile: { integrationId: string; credentialId: string }[];
    configuration: { integrationId: string; credentialId: string }[];
    parse: { integrationId: string; credentialId: string }[];
    unknownKey: { integrationId: string; credentialId: string }[];
    decryptOrAad: { integrationId: string; credentialId: string }[];
  };
  nextCursor: string | null;
  /** Every credential in this page decrypted and matched, and the keys line up. */
  batchPasses: boolean;
};

export type GitLabDecryptabilityResult =
  | { kind: 'ok'; batch: GitLabDecryptabilityBatch }
  | { kind: 'error'; errorCode: string; retryable: boolean };

/**
 * Verify that credentials written by backfill actually decrypt. This is the one
 * safety check that cannot be SQL: the private key lives in the git-token
 * service, so the web app (which only holds the public key) must ask it to
 * decrypt each row. Walk every page (pass `nextCursor` back as `cursor`) before
 * scrubbing; the migration passes only when all pages pass.
 */
export async function verifyGitLabCredentialDecryptabilityBatch(input: {
  requestedByUserId: string;
  cursor: string | null;
}): Promise<GitLabDecryptabilityResult> {
  let webKey: KeyInfo;
  try {
    webKey = getGitLabCredentialEncryptionPublicKeyInfo();
  } catch {
    return { kind: 'error', errorCode: 'public_key_unavailable', retryable: false };
  }

  const response = await requestGitLabCredentialPrivateAudit({
    requestedByUserId: input.requestedByUserId,
    cursor: input.cursor,
  });
  if (response.kind === 'terminal_error') {
    return { kind: 'error', errorCode: response.errorCode, retryable: false };
  }
  if (response.kind === 'retryable_error') {
    return { kind: 'error', errorCode: response.errorCode, retryable: true };
  }

  const { audit } = response;
  const keyMatches =
    audit.activeKey !== null &&
    audit.activeKey.keyId === webKey.keyId &&
    audit.activeKey.publicKeySha256 === webKey.publicKeySha256;
  const noFailures =
    audit.counts.credentials === audit.counts.passedCredentials &&
    audit.counts.profileFailures === 0 &&
    audit.counts.configurationFailures === 0 &&
    audit.counts.parseFailures === 0 &&
    audit.counts.unknownKeyFailures === 0 &&
    audit.counts.decryptOrAadFailures === 0;

  return {
    kind: 'ok',
    batch: {
      keyMatches,
      activeKey: audit.activeKey,
      webKey,
      counts: audit.counts,
      failing: audit.failingCredentials,
      nextCursor: audit.nextCursor,
      batchPasses: audit.activeKey !== null && keyMatches && noFailures,
    },
  };
}

/**
 * Cheap pre-scrub guard: confirm the web app's public key and the git-token
 * service's active private key are the same pair. Guards the dominant,
 * catastrophic failure mode (keypair mismatch → every encrypted row is
 * permanently undecryptable) on every scrub call without re-auditing the whole
 * population. Full decrypt coverage comes from
 * `verifyGitLabCredentialDecryptabilityBatch`.
 */
export async function checkGitLabCredentialKeysMatch(
  requestedByUserId: string
): Promise<{ ok: boolean; errorCode?: string }> {
  let webKey: KeyInfo;
  try {
    webKey = getGitLabCredentialEncryptionPublicKeyInfo();
  } catch {
    return { ok: false, errorCode: 'public_key_unavailable' };
  }
  const response = await requestGitLabCredentialPrivateAudit({
    requestedByUserId,
    cursor: null,
    limit: 1,
  });
  if (response.kind !== 'success') return { ok: false, errorCode: response.errorCode };
  const activeKey = response.audit.activeKey;
  if (!activeKey) return { ok: false, errorCode: 'private_key_unavailable' };
  const ok =
    activeKey.keyId === webKey.keyId && activeKey.publicKeySha256 === webKey.publicKeySha256;
  return ok ? { ok: true } : { ok: false, errorCode: 'private_public_key_mismatch' };
}
