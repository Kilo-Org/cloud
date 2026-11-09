import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  cli_sessions_v2,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

describe('unifiedSessionsRouter organization scope', () => {
  let user: User;
  let activeOrganization: Organization;
  let removedOrganization: Organization;
  let deletedOrganization: Organization;
  const sessionIds = [
    `ses_unified_${crypto.randomUUID()}`,
    `ses_unified_${crypto.randomUUID()}`,
    `ses_unified_${crypto.randomUUID()}`,
    `ses_unified_${crypto.randomUUID()}`,
  ];

  beforeAll(async () => {
    user = await insertTestUser();
    activeOrganization = await createTestOrganization(
      `Unified active ${crypto.randomUUID()}`,
      user.id,
      0
    );
    removedOrganization = await createTestOrganization(
      `Unified removed ${crypto.randomUUID()}`,
      user.id,
      0
    );
    deletedOrganization = await createTestOrganization(
      `Unified deleted ${crypto.randomUUID()}`,
      user.id,
      0
    );

    await db.insert(cli_sessions_v2).values([
      {
        session_id: sessionIds[0],
        kilo_user_id: user.id,
        organization_id: null,
        created_on_platform: 'unknown',
      },
      {
        session_id: sessionIds[1],
        kilo_user_id: user.id,
        organization_id: activeOrganization.id,
        created_on_platform: 'unknown',
      },
      {
        session_id: sessionIds[2],
        kilo_user_id: user.id,
        organization_id: removedOrganization.id,
        created_on_platform: 'unknown',
      },
      {
        session_id: sessionIds[3],
        kilo_user_id: user.id,
        organization_id: deletedOrganization.id,
        created_on_platform: 'unknown',
      },
    ]);

    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, removedOrganization.id),
          eq(organization_memberships.kilo_user_id, user.id)
        )
      );
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, deletedOrganization.id));
  });

  afterAll(async () => {
    await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.session_id, sessionIds));
    await db
      .delete(organization_memberships)
      .where(
        inArray(organization_memberships.organization_id, [
          activeOrganization.id,
          removedOrganization.id,
          deletedOrganization.id,
        ])
      );
    await db
      .delete(organizations)
      .where(
        inArray(organizations.id, [
          activeOrganization.id,
          removedOrganization.id,
          deletedOrganization.id,
        ])
      );
  });

  it('keeps personal and active org sessions in an unfiltered list', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.unifiedSessions.list({});

    const ids = result.cliSessions.map(session => session.session_id);
    expect(ids).toEqual(expect.arrayContaining([sessionIds[0], sessionIds[1]]));
    expect(ids).not.toContain(sessionIds[2]);
    expect(ids).not.toContain(sessionIds[3]);
  });

  it('denies an explicit scope for a soft-deleted organization', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.unifiedSessions.list({ organizationId: deletedOrganization.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
