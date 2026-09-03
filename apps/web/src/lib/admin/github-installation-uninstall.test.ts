import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  agent_configs,
  organization_audit_logs,
  organizations,
  platform_integrations,
  user_admin_notes,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { verifyAndDeleteGitHubOrganizationInstallation } from '@/lib/integrations/platforms/github/adapter';
import { uninstallGitHubOrganizationInstallation } from './github-installation-uninstall';

const mockBotInitialize = jest.fn<Promise<void>, []>();
const mockBotGetState = jest.fn<unknown, []>();
const mockUnlinkTeamKiloUsers = jest.fn<Promise<number>, []>();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  verifyAndDeleteGitHubOrganizationInstallation: jest.fn(),
}));

jest.mock('@/lib/organizations/organization-audit-logs', () => {
  const actual = jest.requireActual('@/lib/organizations/organization-audit-logs');
  return { ...actual, createAuditLog: jest.fn(actual.createAuditLog) };
});

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: () => mockBotInitialize(),
    getState: () => mockBotGetState(),
  },
}));

jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: () => mockUnlinkTeamKiloUsers(),
}));

const upstream = jest.mocked(verifyAndDeleteGitHubOrganizationInstallation);
const audit = jest.mocked(createAuditLog);

async function integration(owner: { userId?: string; organizationId?: string }, overrides = {}) {
  const [row] = await db
    .insert(platform_integrations)
    .values({
      platform: 'github',
      integration_type: 'app',
      owned_by_user_id: owner.userId,
      owned_by_organization_id: owner.organizationId,
      platform_installation_id: '123',
      platform_account_id: '456',
      github_app_type: 'standard',
      integration_status: 'active',
      ...overrides,
    })
    .returning();
  return row!;
}

function request(
  row: { id: string },
  owner: { type: 'user' | 'organization'; id: string },
  overrides = {}
) {
  return {
    integrationId: row.id,
    installationId: '123',
    accountId: '456',
    appType: 'standard' as const,
    owner,
    confirmation: '123',
    ...overrides,
  };
}

describe('uninstallGitHubOrganizationInstallation', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    upstream.mockReset();
    upstream.mockResolvedValue();
    audit.mockReset();
    audit.mockImplementation(
      jest.requireActual('@/lib/organizations/organization-audit-logs').createAuditLog
    );
    mockBotInitialize.mockResolvedValue();
    mockBotGetState.mockReturnValue({});
    mockUnlinkTeamKiloUsers.mockResolvedValue(0);
  });

  test.each([{ is_admin: false }, { blocked_reason: 'blocked' }])(
    'rejects a currently inactive admin before upstream work: %j',
    async change => {
      const actor = await insertTestUser({ is_admin: true });
      const owner = await insertTestUser();
      const row = await integration({ userId: owner.id });
      await db.update(kilocode_users).set(change).where(eq(kilocode_users.id, actor.id));

      await expect(
        uninstallGitHubOrganizationInstallation({
          input: request(row, { type: 'user', id: owner.id }),
          actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(upstream).not.toHaveBeenCalled();
    }
  );

  test.each([
    { owner: { type: 'user' as const, id: 'other' } },
    { accountId: '999' },
    { installationId: '999', confirmation: '999' },
    { appType: 'lite' as const },
  ])('rejects stale snapshot before upstream work', async override => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const row = await integration({ userId: owner.id });
    await expect(
      uninstallGitHubOrganizationInstallation({
        input: request(row, { type: 'user', id: owner.id }, override),
        actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
      })
    ).rejects.toThrow('Refresh before retrying');
    expect(upstream).not.toHaveBeenCalled();
  });

  test('deletes only selected user association and preserves sibling and audit attribution', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser({ id: 'oauth/github|owner' });
    const row = await integration({ userId: owner.id });
    const sibling = await integration({ userId: owner.id }, { platform_installation_id: '789' });
    await expect(
      uninstallGitHubOrganizationInstallation({
        input: request(row, { type: 'user', id: owner.id }),
        actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
      })
    ).resolves.toEqual({ status: 'uninstalled', localCleanup: 'complete' });
    expect(
      await db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, row.id),
      })
    ).toBeUndefined();
    expect(
      await db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, sibling.id),
      })
    ).toBeDefined();
    const notes = await db
      .select()
      .from(user_admin_notes)
      .where(eq(user_admin_notes.kilo_user_id, owner.id));
    expect(notes).toHaveLength(2);
    expect(notes.every(note => note.admin_kilo_user_id === actor.id)).toBe(true);
  });

  test('supports legacy standard association and preserves organization resources', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const org = await createTestOrganization('Uninstall test org', owner.id, 0);
    const row = await integration({ organizationId: org.id }, { github_app_type: null });
    const [config] = await db
      .insert(agent_configs)
      .values({
        owned_by_organization_id: org.id,
        agent_type: 'code_review',
        platform: 'github',
        config: {},
        created_by: owner.id,
      })
      .returning();
    await uninstallGitHubOrganizationInstallation({
      input: request(row, { type: 'organization', id: org.id }),
      actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
    });
    expect(
      await db.query.organizations.findFirst({ where: eq(organizations.id, org.id) })
    ).toBeDefined();
    expect(
      await db.query.agent_configs.findFirst({ where: eq(agent_configs.id, config!.id) })
    ).toBeDefined();
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, org.id));
    expect(audits).toHaveLength(2);
    expect(
      audits.every(audit => audit.actor_id === actor.id && audit.message.includes(row.id))
    ).toBe(true);
  });

  test.each([401, 403, 404, 'timeout'])(
    'leaves local association on upstream %s',
    async failure => {
      const actor = await insertTestUser({ is_admin: true });
      const owner = await insertTestUser();
      const row = await integration({ userId: owner.id });
      upstream.mockRejectedValue({ status: failure });
      await expect(
        uninstallGitHubOrganizationInstallation({
          input: request(row, { type: 'user', id: owner.id }),
          actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
        })
      ).rejects.toThrow('Refresh before retrying');
      expect(
        await db.query.platform_integrations.findFirst({
          where: eq(platform_integrations.id, row.id),
        })
      ).toBeDefined();
    }
  );

  test('rejects effective duplicate legacy rows before upstream deletion', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const row = await integration({ userId: owner.id });
    const otherOwner = await insertTestUser();
    await integration({ userId: otherOwner.id }, { github_app_type: null });
    await expect(
      uninstallGitHubOrganizationInstallation({
        input: request(row, { type: 'user', id: owner.id }),
        actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
      })
    ).rejects.toThrow('Refresh before retrying');
    expect(upstream).not.toHaveBeenCalled();
  });

  test('serializes admin revocation and target reassignment during upstream deletion', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const replacementOwner = await insertTestUser();
    const row = await integration({ userId: owner.id });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    upstream.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const uninstall = uninstallGitHubOrganizationInstallation({
      input: request(row, { type: 'user', id: owner.id }),
      actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
    });

    try {
      await Promise.race([
        entered.promise,
        uninstall.then(() => {
          throw new Error('Uninstall completed without the expected upstream gate');
        }),
      ]);
      await expect(
        db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await tx
            .update(kilocode_users)
            .set({ is_admin: false })
            .where(eq(kilocode_users.id, actor.id));
        })
      ).rejects.toThrow();
      await expect(
        db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await tx
            .update(platform_integrations)
            .set({ owned_by_user_id: replacementOwner.id })
            .where(eq(platform_integrations.id, row.id));
        })
      ).rejects.toThrow();
    } finally {
      release.resolve();
      await uninstall;
    }
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test('returns pending and retains local row when confirmed cleanup transaction fails', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const org = await createTestOrganization('Uninstall pending org', owner.id, 0);
    const row = await integration({ organizationId: org.id });
    audit.mockImplementationOnce(
      jest.requireActual('@/lib/organizations/organization-audit-logs').createAuditLog
    );
    audit.mockRejectedValueOnce(new Error('final audit private database error'));
    audit.mockImplementationOnce(
      jest.requireActual('@/lib/organizations/organization-audit-logs').createAuditLog
    );

    await expect(
      uninstallGitHubOrganizationInstallation({
        input: request(row, { type: 'organization', id: org.id }),
        actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
      })
    ).resolves.toEqual({ status: 'uninstalled', localCleanup: 'pending' });
    expect(
      await db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, row.id),
      })
    ).toBeDefined();
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, org.id));
    expect(audits.map(entry => entry.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('uninstall attempted'),
        expect.stringContaining('confirmed; local cleanup pending'),
      ])
    );
  });

  test('standard deletion webhook reconciles a legacy row retained after local cleanup rolls back', async () => {
    const actor = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const org = await createTestOrganization('Uninstall webhook reconciliation org', owner.id, 0);
    const row = await integration({ organizationId: org.id }, { github_app_type: null });
    audit.mockImplementationOnce(
      jest.requireActual('@/lib/organizations/organization-audit-logs').createAuditLog
    );
    audit.mockRejectedValueOnce(new Error('final audit private database error'));
    audit.mockImplementationOnce(
      jest.requireActual('@/lib/organizations/organization-audit-logs').createAuditLog
    );

    await expect(
      uninstallGitHubOrganizationInstallation({
        input: request(row, { type: 'organization', id: org.id }),
        actor: { id: actor.id, email: actor.google_user_email, name: actor.google_user_name },
      })
    ).resolves.toEqual({ status: 'uninstalled', localCleanup: 'pending' });
    expect(
      await db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, row.id),
      })
    ).toBeDefined();

    const { handleInstallationDeleted } =
      await import('@/lib/integrations/platforms/github/webhook-handlers/installation-handler');
    await handleInstallationDeleted(
      { action: 'deleted', installation: { id: 123 } } as never,
      'standard'
    );

    expect(
      await db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, row.id),
      })
    ).toBeUndefined();
  });
});
