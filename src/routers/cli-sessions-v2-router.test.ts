import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_webhook_triggers,
  cli_sessions_v2,
  agent_environment_profiles,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';

jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://test-ingest.example.com',
  };
});

let regularUser: User;
let otherUser: User;
let testOrganization: Organization;

describe('cli-sessions-v2-router', () => {
  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'cli-sessions-v2-user@example.com',
      google_user_name: 'CLI Sessions V2 User',
      is_admin: false,
    });

    otherUser = await insertTestUser({
      google_user_email: 'cli-sessions-v2-other@example.com',
      google_user_name: 'CLI Sessions V2 Other User',
      is_admin: false,
    });

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'CLI Sessions V2 Test Org',
        created_by_kilo_user_id: regularUser.id,
      })
      .returning();
    testOrganization = org;
  });

  describe('shareForWebhookTrigger', () => {
    let triggerId: string;
    let profileId: string;
    const testTriggerId = 'test-trigger-share-v2';

    beforeAll(async () => {
      const [profile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_user_id: regularUser.id,
          name: 'share-test-profile-v2',
        })
        .returning({ id: agent_environment_profiles.id });
      profileId = profile.id;

      const [trigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: testTriggerId,
          user_id: regularUser.id,
          github_repo: 'test/repo',
          profile_id: profileId,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });
      triggerId = trigger.id;
    });

    afterAll(async () => {
      await db
        .delete(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.id, triggerId));
      await db
        .delete(agent_environment_profiles)
        .where(eq(agent_environment_profiles.id, profileId));
    });

    const v2SessionId = 'ses_test_share_v2_session_1234';
    let fetchSpy: jest.SpyInstance;

    beforeEach(async () => {
      await db.insert(cli_sessions_v2).values({
        session_id: v2SessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'webhook',
      });

      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, public_id: 'test-public-uuid' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    afterEach(async () => {
      fetchSpy.mockRestore();
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, v2SessionId));
    });

    it('should share a v2 session via the session-ingest worker', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessionsV2.shareForWebhookTrigger({
        kilo_session_id: v2SessionId,
        trigger_id: testTriggerId,
      });

      expect(result).toEqual({
        share_id: 'test-public-uuid',
        session_id: v2SessionId,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [fetchUrl, fetchOpts] = fetchSpy.mock.calls[0];
      expect(fetchUrl).toBe(
        `https://test-ingest.example.com/api/session/${encodeURIComponent(v2SessionId)}/share`
      );
      expect(fetchOpts.method).toBe('POST');
      expect(fetchOpts.headers.Authorization).toMatch(/^Bearer .+/);
    });

    it('should throw NOT_FOUND for non-existent v2 session', async () => {
      await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, v2SessionId));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: 'ses_nonexistent_session_12345',
          trigger_id: testTriggerId,
        })
      ).rejects.toThrow('Session not found');
    });

    it('should throw INTERNAL_SERVER_ERROR when session-ingest returns an error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      );

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: v2SessionId,
          trigger_id: testTriggerId,
        })
      ).rejects.toThrow('Session share failed: 500 Internal Server Error');
    });

    it('should throw NOT_FOUND when session belongs to a different user (personal trigger)', async () => {
      // Session is created by regularUser (via beforeEach), but otherUser tries to share it
      // otherUser needs their own trigger to pass verifyWebhookTriggerAccess
      const [otherProfile] = await db
        .insert(agent_environment_profiles)
        .values({
          owned_by_user_id: otherUser.id,
          name: 'other-user-share-profile-v2',
        })
        .returning({ id: agent_environment_profiles.id });

      const otherTriggerId = 'test-trigger-share-other-user-v2';
      const [otherTrigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: otherTriggerId,
          user_id: otherUser.id,
          github_repo: 'test/other-repo',
          profile_id: otherProfile.id,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });

      try {
        const caller = await createCallerForUser(otherUser.id);
        await expect(
          caller.cliSessionsV2.shareForWebhookTrigger({
            kilo_session_id: v2SessionId,
            trigger_id: otherTriggerId,
          })
        ).rejects.toThrow('Session not found');
      } finally {
        await db
          .delete(cloud_agent_webhook_triggers)
          .where(eq(cloud_agent_webhook_triggers.id, otherTrigger.id));
        await db
          .delete(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, otherProfile.id));
      }
    });

    it('should throw NOT_FOUND when session belongs to a different org (org trigger)', async () => {
      // Create a session belonging to testOrganization
      const orgSessionId = 'ses_test_share_v2_org_session_1234';
      await db.insert(cli_sessions_v2).values({
        session_id: orgSessionId,
        kilo_user_id: regularUser.id,
        created_on_platform: 'webhook',
        organization_id: testOrganization.id,
      });

      // Create a second org and an org trigger for it
      const [otherOrg] = await db
        .insert(organizations)
        .values({
          name: 'Other Org for Share Test V2',
          created_by_kilo_user_id: regularUser.id,
        })
        .returning();

      await db.insert(organization_memberships).values({
        organization_id: otherOrg.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const [otherProfile] = await db
        .insert(agent_environment_profiles)
        .values({
          name: 'other-org-share-profile-v2',
          owned_by_organization_id: otherOrg.id,
        })
        .returning({ id: agent_environment_profiles.id });

      const otherOrgTriggerId = 'test-trigger-share-other-org-v2';
      const [otherOrgTrigger] = await db
        .insert(cloud_agent_webhook_triggers)
        .values({
          trigger_id: otherOrgTriggerId,
          organization_id: otherOrg.id,
          github_repo: 'test/other-org-repo',
          profile_id: otherProfile.id,
        })
        .returning({ id: cloud_agent_webhook_triggers.id });

      try {
        const caller = await createCallerForUser(regularUser.id);
        // Try to share orgSession (belongs to testOrganization) via otherOrg's trigger
        await expect(
          caller.cliSessionsV2.shareForWebhookTrigger({
            kilo_session_id: orgSessionId,
            trigger_id: otherOrgTriggerId,
            organization_id: otherOrg.id,
          })
        ).rejects.toThrow('Session not found');
      } finally {
        await db
          .delete(cloud_agent_webhook_triggers)
          .where(eq(cloud_agent_webhook_triggers.id, otherOrgTrigger.id));
        await db
          .delete(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, otherProfile.id));
        await db
          .delete(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, otherOrg.id),
              eq(organization_memberships.kilo_user_id, regularUser.id)
            )
          );
        await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, orgSessionId));
        await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
      }
    });

    it('should throw NOT_FOUND for non-existent trigger', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessionsV2.shareForWebhookTrigger({
          kilo_session_id: v2SessionId,
          trigger_id: 'non-existent-trigger',
        })
      ).rejects.toThrow('Trigger not found');
    });
  });
});
