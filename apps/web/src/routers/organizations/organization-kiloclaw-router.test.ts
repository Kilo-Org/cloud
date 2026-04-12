import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kiloclaw_cli_runs, kiloclaw_instances } from '@kilocode/db/schema';

function sandboxId(): string {
  return `ki_${crypto.randomUUID().replace(/-/g, '')}`;
}

describe('organizations.kiloclaw.listKiloCliRuns', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns only runs for the active org instance', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-cli-runs-${Math.random()}@example.com`,
    });
    const organization = await createOrganization(`CLI Runs Org ${Math.random()}`, user.id);
    const otherOrganization = await createOrganization(`Other CLI Runs Org ${Math.random()}`, user.id);

    const [destroyedOrgInstance, activeOrgInstance, otherOrgInstance, personalInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: organization.id,
          destroyed_at: '2026-04-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: organization.id,
        },
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: otherOrganization.id,
        },
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: null,
        },
      ])
      .returning({ id: kiloclaw_instances.id });

    if (!destroyedOrgInstance || !activeOrgInstance || !otherOrgInstance || !personalInstance) {
      throw new Error('Failed to create KiloClaw test instances');
    }

    await db.insert(kiloclaw_cli_runs).values([
      {
        user_id: user.id,
        instance_id: destroyedOrgInstance.id,
        prompt: 'destroyed org instance run',
        status: 'completed',
        started_at: '2026-04-01T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: activeOrgInstance.id,
        prompt: 'active org instance run',
        status: 'completed',
        started_at: '2026-04-04T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: otherOrgInstance.id,
        prompt: 'other org instance run',
        status: 'completed',
        started_at: '2026-04-03T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: personalInstance.id,
        prompt: 'personal instance run',
        status: 'completed',
        started_at: '2026-04-02T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: null,
        prompt: 'legacy null instance run',
        status: 'completed',
        started_at: '2026-04-05T00:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.listKiloCliRuns({
      organizationId: organization.id,
      limit: 10,
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.prompt).toBe('active org instance run');
    expect(result.runs[0]?.instance_id).toBe(activeOrgInstance.id);
  });

  it('returns an empty list when no active org instance exists', async () => {
    const user = await insertTestUser({
      google_user_email: `org-kiloclaw-cli-runs-empty-${Math.random()}@example.com`,
    });
    const organization = await createOrganization(`CLI Runs Empty Org ${Math.random()}`, user.id);

    const [destroyedOrgInstance, personalInstance] = await db
      .insert(kiloclaw_instances)
      .values([
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: organization.id,
          destroyed_at: '2026-04-01T00:00:00.000Z',
        },
        {
          user_id: user.id,
          sandbox_id: sandboxId(),
          organization_id: null,
        },
      ])
      .returning({ id: kiloclaw_instances.id });

    if (!destroyedOrgInstance || !personalInstance) {
      throw new Error('Failed to create KiloClaw test instances');
    }

    await db.insert(kiloclaw_cli_runs).values([
      {
        user_id: user.id,
        instance_id: destroyedOrgInstance.id,
        prompt: 'destroyed org instance run',
        status: 'completed',
        started_at: '2026-04-01T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: personalInstance.id,
        prompt: 'personal instance run',
        status: 'completed',
        started_at: '2026-04-02T00:00:00.000Z',
      },
      {
        user_id: user.id,
        instance_id: null,
        prompt: 'legacy null instance run',
        status: 'completed',
        started_at: '2026-04-03T00:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.organizations.kiloclaw.listKiloCliRuns({
      organizationId: organization.id,
      limit: 10,
    });

    expect(result.runs).toEqual([]);
  });
});
