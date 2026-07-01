import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cli_sessions_v2,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { queryAccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import {
  verifyOrgOwnsSessionV2ByCloudAgentId,
  verifyUserOwnsSessionV2ByCloudAgentId,
} from './session-ownership';

const PERSONAL_SESSION_ID = 'ses_access_personal_1234567890';
const PERSONAL_CLOUD_AGENT_SESSION_ID = 'agent_access_personal';
const ORGANIZATION_SESSION_ID = 'ses_access_organization_123456';
const ORGANIZATION_CLOUD_AGENT_SESSION_ID = 'agent_access_organization';

let owner: User;
let otherMember: User;
let organization: Organization;
let otherOrganization: Organization;

describe('Cloud Agent session ownership', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'cloud-agent-session-owner@example.com',
      google_user_name: 'Cloud Agent Session Owner',
      is_admin: false,
    });
    otherMember = await insertTestUser({
      google_user_email: 'cloud-agent-session-other-member@example.com',
      google_user_name: 'Cloud Agent Session Other Member',
      is_admin: false,
    });

    [organization, otherOrganization] = await db
      .insert(organizations)
      .values([
        {
          name: 'Cloud Agent Session Access Organization',
          created_by_kilo_user_id: owner.id,
        },
        {
          name: 'Other Cloud Agent Session Access Organization',
          created_by_kilo_user_id: owner.id,
        },
      ])
      .returning();

    await db.insert(organization_memberships).values([
      {
        organization_id: organization.id,
        kilo_user_id: owner.id,
        role: 'owner',
      },
      {
        organization_id: organization.id,
        kilo_user_id: otherMember.id,
        role: 'member',
      },
      {
        organization_id: otherOrganization.id,
        kilo_user_id: owner.id,
        role: 'owner',
      },
    ]);
  });

  beforeEach(async () => {
    await db.insert(cli_sessions_v2).values([
      {
        session_id: PERSONAL_SESSION_ID,
        kilo_user_id: owner.id,
        cloud_agent_session_id: PERSONAL_CLOUD_AGENT_SESSION_ID,
        created_on_platform: 'cloud-agent-web',
      },
      {
        session_id: ORGANIZATION_SESSION_ID,
        kilo_user_id: owner.id,
        cloud_agent_session_id: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
        organization_id: organization.id,
        created_on_platform: 'cloud-agent-web',
      },
    ]);
  });

  afterEach(async () => {
    await db
      .delete(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.session_id, [PERSONAL_SESSION_ID, ORGANIZATION_SESSION_ID]));
  });

  afterAll(async () => {
    await db
      .delete(organization_memberships)
      .where(
        inArray(organization_memberships.organization_id, [organization.id, otherOrganization.id])
      );
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [organization.id, otherOrganization.id]));
  });

  it('requires the creator and personal scope for personal session access', async () => {
    await expect(
      verifyUserOwnsSessionV2ByCloudAgentId(db, owner.id, PERSONAL_CLOUD_AGENT_SESSION_ID)
    ).resolves.toEqual({ kiloSessionId: PERSONAL_SESSION_ID });
    await expect(
      queryAccessibleCloudAgentSession(db, {
        kiloUserId: owner.id,
        cloudAgentSessionId: PERSONAL_CLOUD_AGENT_SESSION_ID,
      })
    ).resolves.toEqual({ kiloSessionId: PERSONAL_SESSION_ID, organizationId: null });

    await expect(
      verifyUserOwnsSessionV2ByCloudAgentId(db, otherMember.id, PERSONAL_CLOUD_AGENT_SESSION_ID)
    ).resolves.toBeNull();

    await expect(
      verifyUserOwnsSessionV2ByCloudAgentId(db, owner.id, ORGANIZATION_CLOUD_AGENT_SESSION_ID)
    ).resolves.toBeNull();
  });

  it('requires the creator, exact organization, and current membership', async () => {
    await expect(
      verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        organization.id,
        owner.id,
        ORGANIZATION_CLOUD_AGENT_SESSION_ID
      )
    ).resolves.toEqual({ kiloSessionId: ORGANIZATION_SESSION_ID });

    await expect(
      verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        organization.id,
        otherMember.id,
        ORGANIZATION_CLOUD_AGENT_SESSION_ID
      )
    ).resolves.toBeNull();

    await expect(
      verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        otherOrganization.id,
        owner.id,
        ORGANIZATION_CLOUD_AGENT_SESSION_ID
      )
    ).resolves.toBeNull();
  });

  it('denies access after removal and restores it after rejoining', async () => {
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organization.id),
          eq(organization_memberships.kilo_user_id, owner.id)
        )
      );

    await expect(
      verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        organization.id,
        owner.id,
        ORGANIZATION_CLOUD_AGENT_SESSION_ID
      )
    ).resolves.toBeNull();
    await expect(
      queryAccessibleCloudAgentSession(db, {
        kiloUserId: owner.id,
        cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
      })
    ).resolves.toBeNull();

    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: owner.id,
      role: 'owner',
    });

    await expect(
      verifyOrgOwnsSessionV2ByCloudAgentId(
        db,
        organization.id,
        owner.id,
        ORGANIZATION_CLOUD_AGENT_SESSION_ID
      )
    ).resolves.toEqual({ kiloSessionId: ORGANIZATION_SESSION_ID });
    await expect(
      queryAccessibleCloudAgentSession(db, {
        kiloUserId: owner.id,
        cloudAgentSessionId: ORGANIZATION_CLOUD_AGENT_SESSION_ID,
      })
    ).resolves.toEqual({
      kiloSessionId: ORGANIZATION_SESSION_ID,
      organizationId: organization.id,
    });
  });
});
