/**
 * A GitLab metadata writer must merge only the keys it owns. These tests keep
 * one writer's transaction open while the webhook-secret regeneration runs, so
 * each ordering of the two writes is exercised against a real database.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  kilocode_users,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type * as GitLabAdapter from '@/lib/integrations/platforms/gitlab/adapter';
import {
  mutateGitLabMetadataInTransaction,
  type GitLabMetadataPatch,
} from '@/lib/integrations/platforms/gitlab/metadata-mutation';
import {
  connectWithPAT,
  disconnectGitLabIntegration,
  regenerateWebhookSecret,
} from './gitlab-service';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_KEY_ID = 'platform-credential-key-v1';
const mockCredentialEncryptionConfig: {
  keyId: string | undefined;
  publicKey: string | undefined;
} = {
  keyId: TEST_KEY_ID,
  publicKey: Buffer.from(testKeyPair.publicKey).toString('base64'),
};

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return mockCredentialEncryptionConfig.keyId;
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockCredentialEncryptionConfig.publicKey;
  },
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual<typeof GitLabAdapter>('@/lib/integrations/platforms/gitlab/adapter'),
  validatePersonalAccessToken: async () => ({
    valid: true,
    user: { id: 4242, username: 'gitlab-user', name: 'GitLab User' },
    tokenInfo: { id: 9001, name: 'kilo-pat', scopes: ['api'], active: true },
  }),
  fetchGitLabProjects: async () => [],
}));

const INSTANCE_URL = 'https://gitlab.com';
const RECONNECTED_INSTANCE_URL = 'https://gitlab.example.com';
const PAT_VALUE = 'glpat-test-value';
const INITIAL_SECRET = 'initial-webhook-secret';

const seedMetadata = {
  auth_type: 'oauth',
  gitlab_instance_url: INSTANCE_URL,
  access_token: 'stored-oauth-access-token',
  refresh_token: 'stored-oauth-refresh-token',
  client_id: 'stored-client-id',
  client_secret: 'stored-client-secret',
  webhook_secret: INITIAL_SECRET,
  configured_webhooks: {},
};

/** The metadata patch `connectWithPAT` applies to an existing integration. */
const RECONNECT_PATCH: GitLabMetadataPatch = {
  set: { gitlab_instance_url: RECONNECTED_INSTANCE_URL, auth_type: 'pat' },
  delete: ['access_token', 'refresh_token', 'token_expires_at', 'client_id', 'client_secret'],
};

/** The metadata patch `disconnectGitLabIntegration` applies. */
const DISCONNECT_PATCH: GitLabMetadataPatch = {
  delete: [
    'access_token',
    'refresh_token',
    'token_expires_at',
    'client_id',
    'client_secret',
    'auth_type',
  ],
};

let userId: string;
let integrationId: string;

async function insertIntegration() {
  const [row] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: userId,
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_installation_id: '4242',
      platform_account_id: '4242',
      platform_account_login: 'gitlab-user',
      scopes: ['api'],
      integration_status: 'active',
      metadata: seedMetadata,
    })
    .returning({ id: platform_integrations.id });
  if (!row) throw new Error('Failed to seed a GitLab integration');
  return row.id;
}

async function readIntegration() {
  const [row] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, integrationId));
  if (!row) throw new Error('GitLab integration disappeared');
  return row;
}

function readMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Expected GitLab metadata to be an object');
  }
  return metadata as Record<string, unknown>;
}

/**
 * Waits until a session is queued for this integration's advisory lock. The
 * caller holds that lock, so a queued waiter is the other writer being blocked
 * by it. Returns false when no waiter appears.
 */
async function waitForQueuedAdvisoryLock(targetIntegrationId: string): Promise<boolean> {
  const lockKey = `gitlab-integration:${targetIntegrationId}`;
  // The waiter stays queued until the caller commits, so a wider budget only
  // costs time when the lock is never taken.
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await db.execute<{ waiters: number }>(sql`
      select count(*)::int as waiters
      from pg_locks
      where locktype = 'advisory'
        and not granted
        and objsubid = 1
        and classid::bigint = ((hashtextextended(${lockKey}, 0) >> 32) & 4294967295)
        and objid::bigint = (hashtextextended(${lockKey}, 0) & 4294967295)
    `);
    if ((result.rows[0]?.waiters ?? 0) > 0) return true;
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }
  return false;
}

/**
 * Applies `patch` in an open transaction and runs the regeneration while that
 * transaction still holds the integration lock, so the regeneration cannot
 * observe the patch until it commits.
 */
async function regenerateWhilePatchIsOpen(patch: GitLabMetadataPatch) {
  const patchApplied = Promise.withResolvers<void>();
  const patchMayCommit = Promise.withResolvers<void>();

  const patchTransaction = db.transaction(async tx => {
    await mutateGitLabMetadataInTransaction(tx, integrationId, patch);
    patchApplied.resolve();
    await patchMayCommit.promise;
  });

  try {
    await patchApplied.promise;

    let regenerationFinished = false;
    const regeneration = regenerateWebhookSecret({ type: 'user', id: userId }).finally(() => {
      regenerationFinished = true;
    });
    // Observe the queued write even when the probe below throws before the
    // await, so a failed probe cannot leave an unobserved rejection behind.
    void regeneration.catch(() => undefined);

    const queueObserved = await waitForQueuedAdvisoryLock(integrationId);
    const overlapped = !regenerationFinished;

    // Release before awaiting the regeneration; it is queued behind the lock.
    patchMayCommit.resolve();
    await patchTransaction;

    return { regenerated: await regeneration, overlapped, queueObserved };
  } finally {
    // Release on every path, including a throwing probe, so the transaction
    // never keeps the integration lock and a pool connection open.
    patchMayCommit.resolve();
    await patchTransaction;
  }
}

describe('GitLab metadata writes during a webhook-secret regeneration', () => {
  beforeEach(async () => {
    mockCredentialEncryptionConfig.keyId = TEST_KEY_ID;
    mockCredentialEncryptionConfig.publicKey = Buffer.from(testKeyPair.publicKey).toString(
      'base64'
    );
    const user = await insertTestUser();
    userId = user.id;
    integrationId = await insertIntegration();
  });

  afterEach(async () => {
    await db
      .delete(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integrationId));
    await db
      .delete(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integrationId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  it('observes a queued waiter only for its own integration lock', async () => {
    const patchApplied = Promise.withResolvers<void>();
    const patchMayCommit = Promise.withResolvers<void>();
    const patchTransaction = db.transaction(async tx => {
      await mutateGitLabMetadataInTransaction(tx, integrationId, RECONNECT_PATCH);
      patchApplied.resolve();
      await patchMayCommit.promise;
    });

    let otherIntegrationObserved = false;
    let ownIntegrationObserved = false;

    try {
      await patchApplied.promise;

      const regeneration = regenerateWebhookSecret({ type: 'user', id: userId });
      void regeneration.catch(() => undefined);
      otherIntegrationObserved = await waitForQueuedAdvisoryLock('another-integration');
      ownIntegrationObserved = await waitForQueuedAdvisoryLock(integrationId);

      patchMayCommit.resolve();
      await patchTransaction;
      await regeneration;
    } finally {
      // Release on every path, including a throwing probe, so the transaction
      // never keeps the integration lock and a pool connection open.
      patchMayCommit.resolve();
      await patchTransaction;
    }

    expect(otherIntegrationObserved).toBe(false);
    expect(ownIntegrationObserved).toBe(true);
  });

  it('keeps the reconnect fields when a PAT reconnect commits first', async () => {
    const { regenerated, overlapped, queueObserved } =
      await regenerateWhilePatchIsOpen(RECONNECT_PATCH);

    const metadata = readMetadata((await readIntegration()).metadata);
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
    expect(metadata.gitlab_instance_url).toBe(RECONNECTED_INSTANCE_URL);
    expect(metadata.auth_type).toBe('pat');
    expect(metadata).not.toHaveProperty('access_token');
    expect(metadata).not.toHaveProperty('refresh_token');
    expect(metadata).not.toHaveProperty('client_secret');
    expect(queueObserved).toBe(true);
    expect(overlapped).toBe(true);
  });

  it('keeps the disconnect removals when a disconnect commits first', async () => {
    const { regenerated, overlapped, queueObserved } =
      await regenerateWhilePatchIsOpen(DISCONNECT_PATCH);

    const metadata = readMetadata((await readIntegration()).metadata);
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
    expect(metadata).not.toHaveProperty('access_token');
    expect(metadata).not.toHaveProperty('refresh_token');
    expect(metadata).not.toHaveProperty('client_secret');
    expect(metadata).not.toHaveProperty('auth_type');
    expect(queueObserved).toBe(true);
    expect(overlapped).toBe(true);
  });

  it('keeps the regenerated secret when the reconnect commits after it', async () => {
    const regenerated = await regenerateWebhookSecret({ type: 'user', id: userId });
    await db.transaction(tx =>
      mutateGitLabMetadataInTransaction(tx, integrationId, RECONNECT_PATCH)
    );

    const metadata = readMetadata((await readIntegration()).metadata);
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
    expect(metadata.gitlab_instance_url).toBe(RECONNECTED_INSTANCE_URL);
    expect(metadata.auth_type).toBe('pat');
  });

  it('keeps the regenerated secret when the disconnect commits after it', async () => {
    const regenerated = await regenerateWebhookSecret({ type: 'user', id: userId });
    await db.transaction(tx =>
      mutateGitLabMetadataInTransaction(tx, integrationId, DISCONNECT_PATCH)
    );

    const metadata = readMetadata((await readIntegration()).metadata);
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
    expect(metadata).not.toHaveProperty('access_token');
    expect(metadata).not.toHaveProperty('auth_type');
  });

  it('keeps both writers fields when a real PAT connect overlaps a regeneration', async () => {
    const owner = { type: 'user', id: userId } as const;
    const [, regenerated] = await Promise.all([
      connectWithPAT(owner, PAT_VALUE, INSTANCE_URL, userId),
      regenerateWebhookSecret(owner),
    ]);

    const integration = await readIntegration();
    const metadata = readMetadata(integration.metadata);
    expect(metadata.gitlab_instance_url).toBe(INSTANCE_URL);
    expect(metadata.auth_type).toBe('pat');
    expect(metadata).not.toHaveProperty('access_token');
    expect(metadata).not.toHaveProperty('refresh_token');
    expect(metadata).not.toHaveProperty('client_secret');
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
  });

  it('keeps the disconnect removals when a real disconnect overlaps a regeneration', async () => {
    const owner = { type: 'user', id: userId } as const;
    const [, regenerated] = await Promise.all([
      disconnectGitLabIntegration(owner, userId),
      regenerateWebhookSecret(owner),
    ]);

    const integration = await readIntegration();
    const metadata = readMetadata(integration.metadata);
    expect(integration.integration_status).toBe('suspended');
    expect(metadata.webhook_secret).toBe(regenerated.webhookSecret);
    expect(metadata).not.toHaveProperty('access_token');
    expect(metadata).not.toHaveProperty('refresh_token');
    expect(metadata).not.toHaveProperty('client_secret');
    expect(metadata).not.toHaveProperty('auth_type');
  });
});
