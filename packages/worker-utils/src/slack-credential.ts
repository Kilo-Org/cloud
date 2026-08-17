/**
 * Single source of truth for the Slack OAuth credential envelope: scheme, version,
 * AAD, and the advisory-lock key used to serialize refreshes.
 *
 * This lives in worker-utils rather than in `apps/web` so that the Step 4 refresh
 * loop (wherever it ends up running) and the web write path cannot drift. The
 * Bitbucket-OAuth and GitHub-user-token schemes each defined their scheme and AAD
 * locally in `apps/web` and are now duplicated per consumer; do not repeat that here.
 *
 * The AAD binds each ciphertext to the row, the parent integration, the Slack
 * workspace, the owner, the secret kind, and `credentialVersion`. Because
 * `credentialVersion` is inside the AAD, every re-encrypt MUST write a new version
 * and every decrypt MUST use the version stored alongside the ciphertext. That is
 * what makes a replayed or relocated ciphertext fail authentication instead of
 * silently decrypting.
 */

export const SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME = 'slack-oauth-credential-rsa-aes-256-gcm';
export const SLACK_OAUTH_CREDENTIAL_ENVELOPE_VERSION = 1;
export const SLACK_OAUTH_CREDENTIAL_PLATFORM = 'slack';

/**
 * `access` is the Slack bot token (`xoxb-`, or `xoxe.xoxb-` once rotation is on).
 * `refresh` is the rotation refresh token (`xoxe-`) and is absent until rotation
 * is enabled on the Slack app.
 */
export type SlackOAuthSecretKind = 'access' | 'refresh';

export type SlackCredentialOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

export type SlackOAuthCredentialAadInput = {
  credentialId: string;
  integrationId: string;
  slackTeamId: string;
  owner: SlackCredentialOwner;
  credentialVersion: number;
  kind: SlackOAuthSecretKind;
};

function normalizeSlackCredentialOwner(owner: SlackCredentialOwner): SlackCredentialOwner {
  // Rebuild positionally so that callers passing a wider object cannot change the
  // serialized AAD by carrying extra keys.
  return { type: owner.type, id: owner.id };
}

export function buildSlackOAuthCredentialAad(input: SlackOAuthCredentialAadInput): string {
  return JSON.stringify({
    scheme: SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    version: SLACK_OAUTH_CREDENTIAL_ENVELOPE_VERSION,
    platform: SLACK_OAUTH_CREDENTIAL_PLATFORM,
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    slackTeamId: input.slackTeamId,
    owner: normalizeSlackCredentialOwner(input.owner),
    credentialVersion: input.credentialVersion,
    kind: input.kind,
  });
}

/**
 * Advisory-lock key for serializing token refreshes for one installation, keyed on
 * the parent integration so concurrent refreshes for the same workspace serialize
 * while different workspaces proceed in parallel. Used with
 * `pg_advisory_xact_lock(hashtextextended(<key>, 0))` in Step 4.
 */
export function buildSlackCredentialLockKey(integrationId: string): string {
  return `slack-oauth-credential:integration:${integrationId}`;
}
