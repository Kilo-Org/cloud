import { afterAll, describe, expect, it } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { getAgentConfig } from '@/lib/agent-config/db/agent-configs';
import { db } from '@/lib/drizzle';
import { agent_configs, organization_audit_logs, organizations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

const createdOrganizationIds: string[] = [];

async function createFixtureOrganization() {
  const owner = await insertTestUser();
  // require_seats=false grants the trial-bypass that organizationBillingMutationProcedure needs.
  const organization = await createTestOrganization(
    `Code Reviews ${crypto.randomUUID()}`,
    owner.id,
    0,
    {},
    false
  );
  createdOrganizationIds.push(organization.id);
  return { owner, organization };
}

async function settingsChangeAuditLogs(organizationId: string) {
  return db
    .select({ message: organization_audit_logs.message })
    .from(organization_audit_logs)
    .where(
      and(
        eq(organization_audit_logs.organization_id, organizationId),
        eq(organization_audit_logs.action, 'organization.settings.change')
      )
    );
}

describe('organization review agent router: toggleReviewAgent', () => {
  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(agent_configs)
        .where(eq(agent_configs.owned_by_organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  it('does not audit a disable for a platform that never had a config', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: false,
    });

    expect(result).toEqual({ success: true, isEnabled: false });
    // No config row was created and nothing was disabled, so no state transition to audit.
    expect(await getAgentConfig(organization.id, 'code_review', 'github')).toBeNull();
    expect(await settingsChangeAuditLogs(organization.id)).toHaveLength(0);
  });

  it('audits enabling the agent for the first time', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    expect(result).toEqual({ success: true, isEnabled: true });
    expect(await getAgentConfig(organization.id, 'code_review', 'github')).not.toBeNull();
    const logs = await settingsChangeAuditLogs(organization.id);
    expect(logs).toEqual([{ message: 'Enabled AI Code Review Agent for github' }]);
  });

  it('does not audit re-enabling an already-enabled agent', async () => {
    const { owner, organization } = await createFixtureOrganization();
    const caller = await createCallerForUser(owner.id);

    // First enable creates the config and audits once.
    await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    // Repeating the same enable is a no-op and must not add another audit row.
    const result = await caller.organizations.reviewAgent.toggleReviewAgent({
      organizationId: organization.id,
      platform: 'github',
      isEnabled: true,
    });

    expect(result).toEqual({ success: true, isEnabled: true });
    const logs = await settingsChangeAuditLogs(organization.id);
    expect(logs).toEqual([{ message: 'Enabled AI Code Review Agent for github' }]);
  });
});
