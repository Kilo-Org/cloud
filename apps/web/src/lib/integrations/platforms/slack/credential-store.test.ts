import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_KEY_ID = 'slack-credential-key-v1';

const mockConfig: { keyset: string | undefined } = {
  keyset: JSON.stringify({
    active: { keyId: TEST_KEY_ID, publicKeyPem: testKeyPair.publicKey },
    decrypt: [{ keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey }],
  }),
};

jest.mock('@/lib/config.server', () => ({
  get SLACK_CREDENTIAL_KEYSET_JSON() {
    return mockConfig.keyset;
  },
}));

import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  platform_integrations,
  slack_oauth_credentials,
} from '@kilocode/db/schema';
import type { SlackCredentialOwner } from '@kilocode/worker-utils/slack-credential';
import {
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
  writeSlackCredential,
} from './credential-store';
import { SlackCredentialDecryptionError } from './credential-encryption';
import { resetSlackCredentialKeysetCacheForTests } from './credential-keyset';

const suffix = `${Date.now()}-${process.env.JEST_WORKER_ID ?? '0'}`;
const userId = `slack-cred-user-${suffix}`;
const teamId = `T${suffix}`.slice(0, 20);
const owner: SlackCredentialOwner = { type: 'user', id: userId };

let integrationId: string;

beforeAll(() => {
  resetSlackCredentialKeysetCacheForTests();
});

beforeEach(async () => {
  await db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Slack Credential Test',
    google_user_image_url: 'https://example.com/avatar.jpg',
    stripe_customer_id: `cus_${suffix}`.slice(0, 40),
  });

  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: teamId,
      platform_account_id: teamId,
      platform_account_login: 'Test Workspace',
      integration_status: 'active',
    })
    .returning();
  integrationId = integration.id;
});

afterEach(async () => {
  // Cascades platform_integrations → slack_oauth_credentials.
  await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
});

describe('writeSlackCredential', () => {
  it('stores the bot token encrypted and reads it back', async () => {
    const written = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
      botUserId: 'U_BOT',
    });

    expect(written.credential_version).toBe(1);
    expect(written.access_token_encrypted).not.toContain('xoxb-first-token');
    expect(written.bot_user_id).toBe('U_BOT');
    expect(written.refresh_token_encrypted).toBeNull();
    expect(written.access_token_expires_at).toBeNull();

    const stored = await getSlackCredentialByIntegrationId(integrationId);
    if (!stored) throw new Error('Expected a stored credential');
    expect(decryptSlackBotToken(stored, owner)).toBe('xoxb-first-token');
  });

  it('bumps credential_version on replacement and keeps the new token readable', async () => {
    await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });
    const replaced = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-second-token',
    });

    expect(replaced.credential_version).toBe(2);

    const stored = await getSlackCredentialByIntegrationId(integrationId);
    if (!stored) throw new Error('Expected a stored credential');
    expect(decryptSlackBotToken(stored, owner)).toBe('xoxb-second-token');
  });

  it('keeps exactly one row per integration', async () => {
    await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });
    await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-second-token',
    });

    const rows = await db
      .select()
      .from(slack_oauth_credentials)
      .where(eq(slack_oauth_credentials.platform_integration_id, integrationId));

    expect(rows).toHaveLength(1);
  });

  it('resets refresh bookkeeping when the credential is replaced', async () => {
    const first = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });
    await db
      .update(slack_oauth_credentials)
      .set({
        refresh_attempt_count: 4,
        revoked_at: new Date().toISOString(),
        revocation_reason: 'refresh_token_rejected',
      })
      .where(eq(slack_oauth_credentials.id, first.id));

    const replaced = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-second-token',
    });

    expect(replaced.refresh_attempt_count).toBe(0);
    expect(replaced.revoked_at).toBeNull();
    expect(replaced.revocation_reason).toBeNull();
  });

  it('stores a refresh token and expiry when rotation data is supplied', async () => {
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const written = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxe.xoxb-rotating-token',
      refreshToken: 'xoxe-refresh-token',
      accessTokenExpiresAt: expiresAt,
    });

    expect(written.refresh_token_encrypted).not.toBeNull();
    expect(written.refresh_token_encrypted).not.toContain('xoxe-refresh-token');
    expect(written.access_token_expires_at).not.toBeNull();
  });
});

describe('decryptSlackBotToken', () => {
  it('returns null for a revoked credential rather than a usable token', async () => {
    const written = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });

    expect(
      decryptSlackBotToken({ ...written, revoked_at: new Date().toISOString() }, owner)
    ).toBeNull();
  });

  it('refuses to decrypt under a different owner', async () => {
    const written = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });

    expect(() => decryptSlackBotToken(written, { type: 'org', id: userId })).toThrow(
      SlackCredentialDecryptionError
    );
  });

  it('refuses to decrypt a row whose stored version has been tampered with', async () => {
    const written = await writeSlackCredential({
      integrationId,
      slackTeamId: teamId,
      owner,
      botToken: 'xoxb-first-token',
    });

    expect(() => decryptSlackBotToken({ ...written, credential_version: 99 }, owner)).toThrow(
      SlackCredentialDecryptionError
    );
  });
});
