/**
 * Offline maintenance command: deletes one Slack integration row and its stored
 * credential by integration id.
 *
 * Usage, dry run first then --execute:
 *   pnpm --filter web script src/scripts/d2026-11-21_remove-unreadable-slack-integration.ts \
 *     --integration-id=<uuid>
 *   pnpm --filter web script src/scripts/d2026-11-21_remove-unreadable-slack-integration.ts \
 *     --integration-id=<uuid> --execute
 *   pnpm --filter web script src/scripts/d2026-11-21_remove-unreadable-slack-integration.ts \
 *     --integration-id=<uuid> --confirm-missing-key=<keyId>
 *
 * --confirm-missing-key=<keyId> is required when the printed `Envelope key id` has no
 * private key in the current keyset: the credential is undecryptable only if that key
 * is gone for good, which the command cannot tell on its own.
 *
 * Before running it: remove the Kilo app in the Slack workspace named in the output, then
 * confirm the integration row is still present. The command prints that workspace id.
 *
 * Requires SLACK_CREDENTIAL_KEYSET_JSON and POSTGRES_SCRIPT_URL. Prints no credential
 * material: no token, ciphertext, or key data. The envelope key id is a label, not key
 * material, so it is printed to let the operator name one with --confirm-missing-key.
 */

import '../lib/load-env';

import { and, eq } from 'drizzle-orm';
import { db, closeAllDrizzleConnections } from '@kilocode/web-shared/lib/drizzle';
import { platform_integrations, type SlackOAuthCredential } from '@kilocode/db/schema';
import { parseKeyedEnvelope } from '@kilocode/encryption';
import {
  SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  type SlackCredentialOwner,
} from '@kilocode/worker-utils/slack-credential';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  SlackCredentialKeysetError,
  isSlackCredentialEncryptionConfigured,
  requireSlackCredentialKeyset,
} from '@/lib/integrations/platforms/slack/credential-keyset';
import { SlackCredentialDecryptionError } from '@/lib/integrations/platforms/slack/credential-encryption';
import {
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
} from '@/lib/integrations/platforms/slack/credential-store';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `remove` is the only outcome that deletes a row; every other outcome names its skip code. */
type Decision =
  | { action: 'remove'; envelope: EnvelopeState }
  | { action: 'skip'; code: SkipCode; envelope?: EnvelopeState };

/** What the stored ciphertext itself says: its key id, and whether we can use that key. */
type EnvelopeState = { keyId: string; privateKeyPresent: boolean };

type SkipCode =
  | 'not_found'
  | 'no_owner'
  | 'no_stored_credential'
  | 'ciphertext_invalid'
  | 'keyset_missing_private_key'
  | 'stored_credential_usable'
  | 'stored_credential_revoked';

function parseArgs(): {
  integrationId: string;
  execute: boolean;
  confirmMissingKey: string | null;
} {
  let integrationId: string | null = null;
  let confirmMissingKey: string | null = null;
  let execute = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg.startsWith('--integration-id=')) {
      integrationId = arg.slice('--integration-id='.length);
    } else if (arg.startsWith('--confirm-missing-key=')) {
      // One key id, so a repeated flag is more likely a mistake than an intent.
      if (confirmMissingKey !== null) {
        throw new Error('--confirm-missing-key accepts one key id and was given more than once');
      }
      const value = arg.slice('--confirm-missing-key='.length);
      if (!value) {
        throw new Error(`Invalid --confirm-missing-key, expected a key id: ${arg}`);
      }
      confirmMissingKey = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!integrationId) {
    throw new Error('Missing required argument: --integration-id=<uuid>');
  }
  if (!UUID_PATTERN.test(integrationId)) {
    throw new Error(`Invalid --integration-id, expected a UUID: ${integrationId}`);
  }

  return { integrationId, execute, confirmMissingKey };
}

function readOwner(integration: {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
}): SlackCredentialOwner | null {
  if (integration.owned_by_organization_id && !integration.owned_by_user_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id && !integration.owned_by_organization_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

/**
 * Mirrors the private-key lookup in `decryptKeyedEnvelope`: the active slot wins for the
 * active key id, and a `decrypt` slot otherwise. A key id found nowhere means the
 * ciphertext was written under a keyset this process no longer holds.
 */
function hasPrivateKeyFor(keyId: string): boolean {
  const { privateKeys } = requireSlackCredentialKeyset();
  if (privateKeys.active.keyId === keyId && privateKeys.active.privateKeyPem) return true;
  return Boolean(privateKeys.decrypt?.some(slot => slot.keyId === keyId && slot.privateKeyPem));
}

/** Separates "this ciphertext is broken" from "we cannot read it right now". */
function readEnvelope(ciphertext: string): EnvelopeState | null {
  try {
    const { keyId } = parseKeyedEnvelope(ciphertext, SLACK_OAUTH_CREDENTIAL_ENVELOPE_SCHEME);
    return { keyId, privateKeyPresent: hasPrivateKeyFor(keyId) };
  } catch {
    // A stored value that is not a valid envelope is not a credential at all, so there is
    // no decryption to attempt and no key to blame.
    return null;
  }
}

/**
 * Attempts the decrypt for a row whose envelope looks readable, or whose missing key the
 * operator has explicitly confirmed as gone.
 */
function attemptDecrypt(
  credential: SlackOAuthCredential,
  owner: SlackCredentialOwner,
  envelope: EnvelopeState
): Decision {
  try {
    const token = decryptSlackBotToken(credential, owner);
    return {
      action: 'skip',
      code: token === null ? 'stored_credential_revoked' : 'stored_credential_usable',
      envelope,
    };
  } catch (error) {
    // A keyset problem is not evidence about this one credential: it fails every row the
    // same way, so it must never reach the removal branch. The decryption error wraps the
    // keyset error as its cause, which is why the check reads the cause too.
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof SlackCredentialKeysetError) throw cause;
    if (error instanceof SlackCredentialKeysetError) throw error;
    if (error instanceof SlackCredentialDecryptionError) return { action: 'remove', envelope };
    throw error;
  }
}

async function decide(
  integrationId: string,
  owner: SlackCredentialOwner,
  confirmMissingKey: string | null
): Promise<Decision> {
  const credential = await getSlackCredentialByIntegrationId(integrationId);
  if (!credential) return { action: 'skip', code: 'no_stored_credential' };

  const envelope = readEnvelope(credential.access_token_encrypted);
  if (!envelope) return { action: 'skip', code: 'ciphertext_invalid' };

  if (envelope.privateKeyPresent) return attemptDecrypt(credential, owner, envelope);

  // Without the key the decrypt is guaranteed to fail on configuration, not on the
  // ciphertext, so failure here would say nothing about the credential. Only an operator
  // who knows the key is permanently gone can authorize the row as unreadable.
  if (confirmMissingKey !== envelope.keyId) {
    return { action: 'skip', code: 'keyset_missing_private_key', envelope };
  }

  return attemptDecrypt(credential, owner, envelope);
}

async function main(): Promise<void> {
  const { integrationId, execute, confirmMissingKey } = parseArgs();

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);

  // Fail before touching a row: with no usable keyset every credential is undecryptable,
  // so the eligibility check below cannot tell a broken key from a stale ciphertext.
  if (!isSlackCredentialEncryptionConfigured()) {
    console.error('Refused: keyset_not_configured');
    process.exitCode = 1;
    return;
  }

  const [integration] = await db
    .select({
      id: platform_integrations.id,
      platform: platform_integrations.platform,
      owned_by_user_id: platform_integrations.owned_by_user_id,
      owned_by_organization_id: platform_integrations.owned_by_organization_id,
      platform_installation_id: platform_integrations.platform_installation_id,
      platform_account_id: platform_integrations.platform_account_id,
    })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.SLACK)
      )
    )
    .limit(1);

  if (!integration) {
    console.error(`Skipped: not_found (${integrationId})`);
    process.exitCode = 1;
    return;
  }

  const owner = readOwner(integration);
  const workspaceId =
    integration.platform_installation_id ?? integration.platform_account_id ?? '(none)';

  const decision: Decision = owner
    ? await decide(integrationId, owner, confirmMissingKey)
    : { action: 'skip', code: 'no_owner' };
  const envelope = decision.envelope;

  console.log('\n--- Integration ---');
  console.log(`Integration id:  ${integration.id}`);
  console.log(`Platform:        ${integration.platform}`);
  console.log(`Workspace id:    ${workspaceId}`);
  console.log(`Owner type:      ${owner ? owner.type : '(none)'}`);
  console.log(`Owner id:        ${owner ? owner.id : '(none)'}`);
  console.log(`Envelope key id: ${envelope ? envelope.keyId : '(none)'}`);

  console.log('\n--- Decision ---');
  if (decision.action === 'skip') {
    console.log(`Skipped: ${decision.code}`);
    if (decision.code === 'keyset_missing_private_key' && envelope) {
      console.log(
        'This keyset holds no private key for the envelope key id above, so the credential is'
      );
      console.log(
        `undecryptable here. Pass --confirm-missing-key=${envelope.keyId} only if that key is`
      );
      console.log('permanently gone: doing so treats the row as removable.');
    }
    console.log('Nothing deleted.');
    process.exitCode = 1;
    return;
  }

  console.log('Action: remove');
  console.log(`Before running: remove the Kilo app in the Slack workspace ${workspaceId} and`);
  console.log('then confirm this integration row is still present.');

  if (!execute) {
    console.log('Dry run: nothing deleted');
    return;
  }

  const deleted = await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, integrationId),
        eq(platform_integrations.platform, PLATFORM.SLACK)
      )
    )
    .returning({ id: platform_integrations.id });

  console.log(`Deleted rows: ${deleted.length}`);

  if (deleted.length === 1) return;

  console.error(`Expected to delete exactly one row, deleted ${deleted.length}.`);
  process.exitCode = 1;
}

void main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
