const mockSyncWebhooksForRepositories = jest.fn();
const mockGetValidGitLabToken = jest.fn();

jest.mock('@/lib/integrations/platforms/gitlab/webhook-sync', () => ({
  syncWebhooksForRepositories: (...args: unknown[]) => mockSyncWebhooksForRepositories(...args),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (...args: unknown[]) => mockGetValidGitLabToken(...args),
}));

// NOTE: `jest` is intentionally NOT imported from '@jest/globals' here. The
// @swc/jest transform only hoists `jest.mock(...)` above the static imports
// when `jest` is the global binding; importing it as a local binding disables
// that hoist, so the mocks below would register AFTER `createCallerForUser`
// pulls in the real gitlab-service. Using global `jest` keeps the mocks hoisted.
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const CREATED_ORG_IDS: string[] = [];
const SEED_USER_IDS: string[] = [];

async function makeOrgAndOwner() {
  const owner = await insertTestUser();
  SEED_USER_IDS.push(owner.id);
  // require_seats=false grants the trial-bypass that
  // organizationBillingMutationProcedure needs.
  const organization = await createTestOrganization(
    `GitLab rotate ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  CREATED_ORG_IDS.push(organization.id);
  return { owner, organization };
}

async function seedGitLabIntegration(
  organizationId: string,
  metadata: Record<string, unknown>
): Promise<{ id: string; secret: string | undefined }> {
  const oldSecret = 'old-secret-do-not-leak';
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: organizationId,
      platform: 'gitlab',
      integration_type: 'oauth',
      integration_status: 'active',
      platform_installation_id: `inst-${crypto.randomUUID()}`,
      metadata: { ...metadata, webhook_secret: oldSecret },
    })
    .returning();
  return { id: integration!.id, secret: oldSecret };
}

async function readMetadata(organizationId: string) {
  const row = await db.query.platform_integrations.findFirst({
    where: and(
      eq(platform_integrations.owned_by_organization_id, organizationId),
      eq(platform_integrations.platform, 'gitlab')
    ),
  });
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

async function readWebhookSecret(organizationId: string): Promise<string | undefined> {
  const md = await readMetadata(organizationId);
  return md.webhook_secret as string | undefined;
}

async function settingsChangeAuditMessages(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ message: organization_audit_logs.message })
    .from(organization_audit_logs)
    .where(
      and(
        eq(organization_audit_logs.organization_id, organizationId),
        eq(organization_audit_logs.action, 'organization.settings.change')
      )
    );
  return rows.map(r => r.message);
}

describe('P1-D-32 GitLab webhook secret (rotation + status)', () => {
  afterAll(async () => {
    for (const organizationId of CREATED_ORG_IDS) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    if (SEED_USER_IDS.length > 0) {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, SEED_USER_IDS));
    }
  });

  beforeEach(() => {
    mockSyncWebhooksForRepositories.mockReset();
    mockGetValidGitLabToken.mockReset();
    // Default sync outcome: every currently-configured repo was "updated"
    // (mirrors the `previous=[]` "treat all as added" path used by rotate).
    mockSyncWebhooksForRepositories.mockImplementation(
      async (_token, _secret, selectedIds, _previous, configuredWebhooks) => {
        const updatedWebhooks: Record<
          string,
          { hook_id: number; created_at: string; updated_at?: string }
        > = {};
        for (const id of selectedIds) {
          const existing = configuredWebhooks[String(id)];
          updatedWebhooks[String(id)] = {
            hook_id: existing?.hook_id ?? 1000 + Number(id),
            created_at: existing?.created_at ?? new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        return {
          result: {
            created: [],
            updated: selectedIds.map((id: number) => ({ projectId: id, hookId: 1000 + id })),
            deleted: [],
            errors: [],
          },
          updatedWebhooks,
        };
      }
    );
    mockGetValidGitLabToken.mockResolvedValue('gitlab-access-token');
  });

  describe('organization review agent router: getGitLabStatus P1-D-32 (omits webhook secret)', () => {
    it('returns the integration shape WITHOUT webhookSecret for a non-privileged member', async () => {
      const { organization } = await makeOrgAndOwner();
      const member = await insertTestUser();
      SEED_USER_IDS.push(member.id);
      await addUserToOrganization(organization.id, member.id, 'member');

      await seedGitLabIntegration(organization.id, {
        gitlab_instance_url: 'https://gitlab.example.com',
        configured_webhooks: { '101': { hook_id: 9001, created_at: '2026-01-01T00:00:00Z' } },
      });

      const caller = await createCallerForUser(member.id);
      const status = await caller.organizations.reviewAgent.getGitLabStatus({
        organizationId: organization.id,
      });

      expect(status.connected).toBe(true);
      expect(status.integration).toBeDefined();
      // Regression guard: the secret must NEVER appear in the status
      // payload. If this assertion fails, the leak has been re-introduced.
      expect(status.integration).not.toHaveProperty('webhookSecret');
      expect((status.integration as Record<string, unknown>).webhookSecret).toBeUndefined();
      // The rest of the shape is preserved (the non-secret fields still ship;
      // account/repositorySelection/installedAt are passed through verbatim from
      // the stored integration row regardless of their concrete values).
      expect(status.integration).toEqual(
        expect.objectContaining({
          isValid: true,
          instanceUrl: 'https://gitlab.example.com',
        })
      );
      expect(status.integration).toHaveProperty('accountLogin');
      expect(status.integration).toHaveProperty('repositorySelection');
      expect(status.integration).toHaveProperty('installedAt');
    });

    it('still omits webhookSecret when the caller is the owner', async () => {
      const { owner, organization } = await makeOrgAndOwner();
      await seedGitLabIntegration(organization.id, {
        gitlab_instance_url: 'https://gitlab.com',
        configured_webhooks: {},
      });

      const caller = await createCallerForUser(owner.id);
      const status = await caller.organizations.reviewAgent.getGitLabStatus({
        organizationId: organization.id,
      });

      expect(status.connected).toBe(true);
      expect(status.integration).not.toHaveProperty('webhookSecret');
    });
  });

  describe('organization review agent router: rotateGitLabWebhookSecret P1-D-32', () => {
    it('is denied for a plain org member (UNAUTHORIZED)', async () => {
      const { organization } = await makeOrgAndOwner();
      const member = await insertTestUser();
      SEED_USER_IDS.push(member.id);
      await addUserToOrganization(organization.id, member.id, 'member');
      await seedGitLabIntegration(organization.id, { configured_webhooks: {} });

      const caller = await createCallerForUser(member.id);
      await expect(
        caller.organizations.reviewAgent.rotateGitLabWebhookSecret({
          organizationId: organization.id,
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('is denied for a non-member (UNAUTHORIZED)', async () => {
      const { organization } = await makeOrgAndOwner();
      // No membership row for this user at all — should be FORBIDDEN by
      // the billing-mutation procedure before the handler runs.
      const stranger = await insertTestUser();
      SEED_USER_IDS.push(stranger.id);
      await seedGitLabIntegration(organization.id, { configured_webhooks: {} });

      const caller = await createCallerForUser(stranger.id);
      await expect(
        caller.organizations.reviewAgent.rotateGitLabWebhookSecret({
          organizationId: organization.id,
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('is allowed for the owner, persists a NEW secret, re-syncs webhooks, and returns the new secret once', async () => {
      const { owner, organization } = await makeOrgAndOwner();
      const configured = {
        '101': { hook_id: 9001, created_at: '2026-01-01T00:00:00Z' },
        '202': { hook_id: 9002, created_at: '2026-01-02T00:00:00Z' },
      };
      await seedGitLabIntegration(organization.id, {
        gitlab_instance_url: 'https://gitlab.example.com',
        configured_webhooks: configured,
      });

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.reviewAgent.rotateGitLabWebhookSecret({
        organizationId: organization.id,
      });

      // Returned secret must be a non-empty hex string and distinct from
      // the previously stored one. The new secret is returned ONCE here.
      expect(typeof result.webhookSecret).toBe('string');
      expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(result.webhookSecret).not.toBe('old-secret-do-not-leak');

      // Re-sync must be invoked exactly once, with the new secret, the
      // configured repo ids (as numbers), previous=[] (so every currently
      // configured repo is treated as "added" and UPDATED in place), the
      // existing configured_webhooks map, and the stored instance URL.
      expect(mockSyncWebhooksForRepositories).toHaveBeenCalledTimes(1);
      expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
        'gitlab-access-token',
        result.webhookSecret,
        [101, 202],
        [],
        configured,
        'https://gitlab.example.com'
      );
      expect(result.webhookSync.updated).toBe(2);
      expect(result.webhookSync.created).toBe(0);
      expect(result.webhookSync.deleted).toBe(0);
      expect(result.webhookSync.errors).toEqual([]);
      expect(result.configuredWebhookCount).toBe(2);

      // Persistence: metadata.webhook_secret is the NEW secret and
      // metadata.configured_webhooks was updated with the sync output.
      const storedSecret = await readWebhookSecret(organization.id);
      expect(storedSecret).toBe(result.webhookSecret);

      const storedMetadata = await readMetadata(organization.id);
      const storedConfigured = storedMetadata.configured_webhooks as Record<
        string,
        { hook_id: number; created_at: string; updated_at?: string }
      >;
      expect(Object.keys(storedConfigured).sort()).toEqual(['101', '202']);
      expect(storedConfigured['101']?.updated_at).toBeDefined();
      expect(storedConfigured['202']?.updated_at).toBeDefined();

      // The new secret is NEVER logged/returned elsewhere — the only
      // exposure point is the one-shot return value above. Audit log
      // records the rotation event WITHOUT the secret.
      const auditMessages = await settingsChangeAuditMessages(organization.id);
      const rotateMessages = auditMessages.filter(m =>
        m.startsWith('Rotated GitLab webhook secret')
      );
      expect(rotateMessages).toHaveLength(1);
      expect(rotateMessages[0]).not.toContain(result.webhookSecret);
      expect(rotateMessages[0]).toContain('2 updated');
    });

    it('is allowed for a billing_manager, with the same re-sync behavior', async () => {
      const { organization } = await makeOrgAndOwner();
      const billingManager = await insertTestUser();
      SEED_USER_IDS.push(billingManager.id);
      await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
      const configured = {
        '303': { hook_id: 9030, created_at: '2026-02-01T00:00:00Z' },
      };
      await seedGitLabIntegration(organization.id, {
        gitlab_instance_url: 'https://gitlab.com',
        configured_webhooks: configured,
      });

      const caller = await createCallerForUser(billingManager.id);
      const result = await caller.organizations.reviewAgent.rotateGitLabWebhookSecret({
        organizationId: organization.id,
      });

      expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
        'gitlab-access-token',
        result.webhookSecret,
        [303],
        [],
        configured,
        'https://gitlab.com'
      );
      expect(await readWebhookSecret(organization.id)).toBe(result.webhookSecret);
    });

    it('with empty configured_webhooks returns the new secret and does NOT call sync', async () => {
      const { owner, organization } = await makeOrgAndOwner();
      await seedGitLabIntegration(organization.id, {
        gitlab_instance_url: 'https://gitlab.example.com',
        configured_webhooks: {},
      });

      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.reviewAgent.rotateGitLabWebhookSecret({
        organizationId: organization.id,
      });

      expect(result.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(result.webhookSync).toEqual({
        created: 0,
        updated: 0,
        deleted: 0,
        errors: [],
      });
      expect(result.configuredWebhookCount).toBe(0);
      expect(mockSyncWebhooksForRepositories).not.toHaveBeenCalled();
      // No token lookup needed when there are no webhooks to re-sync.
      expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
      // The new secret was still persisted for manual reconfiguration.
      expect(await readWebhookSecret(organization.id)).toBe(result.webhookSecret);

      // Audit log mentions the no-rotation branch so operators can tell
      // manual-only rotations apart from synced rotations.
      const auditMessages = await settingsChangeAuditMessages(organization.id);
      expect(auditMessages).toEqual([
        'Rotated GitLab webhook secret (no Kilo-managed webhooks to re-sync)',
      ]);
    });

    it('only touches THIS integration — does not rotate another orgs secret', async () => {
      const { owner: ownerA, organization: orgA } = await makeOrgAndOwner();
      const { organization: orgB } = await makeOrgAndOwner();

      const configuredA = { '1': { hook_id: 1, created_at: '2026-01-01T00:00:00Z' } };
      const configuredB = { '2': { hook_id: 2, created_at: '2026-01-01T00:00:00Z' } };
      await seedGitLabIntegration(orgA.id, {
        gitlab_instance_url: 'https://gitlab.com',
        configured_webhooks: configuredA,
      });
      await seedGitLabIntegration(orgB.id, {
        gitlab_instance_url: 'https://gitlab.com',
        configured_webhooks: configuredB,
      });

      const oldSecretB = await readWebhookSecret(orgB.id);
      expect(oldSecretB).toBe('old-secret-do-not-leak');

      const callerA = await createCallerForUser(ownerA.id);
      const result = await callerA.organizations.reviewAgent.rotateGitLabWebhookSecret({
        organizationId: orgA.id,
      });

      // Org A was rotated; org B is untouched.
      expect(await readWebhookSecret(orgA.id)).toBe(result.webhookSecret);
      expect(await readWebhookSecret(orgB.id)).toBe('old-secret-do-not-leak');

      // Sync was called only once, for org A's configured repo id.
      expect(mockSyncWebhooksForRepositories).toHaveBeenCalledTimes(1);
      expect(mockSyncWebhooksForRepositories).toHaveBeenCalledWith(
        'gitlab-access-token',
        result.webhookSecret,
        [1],
        [],
        configuredA,
        'https://gitlab.com'
      );
    });
  });
});
