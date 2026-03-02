import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import {
  cliSessions,
  sharedCliSessions,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { CliSessionSharedState } from '@/types/cli-session-shared-state';
import { eq, and } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';
import {
  sanitizeGitUrl,
  isValidGitUrl,
  parseGitUrl,
  sanitizeForPostgres,
} from './cli-sessions-router';

jest.mock('@/lib/r2/cli-sessions', () => ({
  generateSignedUrls: jest.fn().mockResolvedValue({
    api_conversation_history_blob_url: 'https://signed-url.example.com/api_conversation_history',
    task_metadata_blob_url: 'https://signed-url.example.com/task_metadata',
    ui_messages_blob_url: 'https://signed-url.example.com/ui_messages',
    git_state_blob_url: 'https://signed-url.example.com/git_state',
  }),
  deleteBlobs: jest.fn().mockResolvedValue(undefined),
  copyBlobs: jest.fn().mockResolvedValue({
    api_conversation_history_blob_url: 'sessions/new-id/api_conversation_history.json',
    task_metadata_blob_url: 'sessions/new-id/task_metadata.json',
    ui_messages_blob_url: 'sessions/new-id/ui_messages.json',
    git_state_blob_url: 'sessions/new-id/git_state.json',
  }),
}));

const deleteCloudAgentSessionMock = jest.fn().mockResolvedValue({ success: true });

jest.mock('@/lib/cloud-agent/cloud-agent-client', () => ({
  createCloudAgentClient: jest.fn(() => ({
    deleteSession: deleteCloudAgentSessionMock,
  })),
}));

let regularUser: User;
let otherUser: User;
let testOrganization: Organization;

describe('cli-sessions-router', () => {
  beforeAll(async () => {
    regularUser = await insertTestUser({
      google_user_email: 'cli-sessions-user@example.com',
      google_user_name: 'CLI Sessions User',
      is_admin: false,
    });

    otherUser = await insertTestUser({
      google_user_email: 'cli-sessions-other@example.com',
      google_user_name: 'CLI Sessions Other User',
      is_admin: false,
    });

    const [org] = await db
      .insert(organizations)
      .values({
        name: 'CLI Sessions Test Org',
        created_by_kilo_user_id: regularUser.id,
      })
      .returning();
    testOrganization = org;
  });

  beforeEach(() => {
    deleteCloudAgentSessionMock.mockClear();
  });

  describe('list procedure', () => {
    let _testSessionIds: string[];

    beforeAll(async () => {
      const sessions = await Promise.all([
        db
          .insert(cliSessions)
          .values({
            kilo_user_id: regularUser.id,
            title: 'Test Session 1',
            created_on_platform: 'vscode',
          })
          .returning({ session_id: cliSessions.session_id }),
        db
          .insert(cliSessions)
          .values({
            kilo_user_id: regularUser.id,
            title: 'Test Session 2',
            created_on_platform: 'cli',
          })
          .returning({ session_id: cliSessions.session_id }),
        db
          .insert(cliSessions)
          .values({
            kilo_user_id: regularUser.id,
            title: 'Test Session 3',
            created_on_platform: 'vscode',
          })
          .returning({ session_id: cliSessions.session_id }),
      ]);

      _testSessionIds = sessions.map(s => s[0].session_id);
    });

    afterAll(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.kilo_user_id, regularUser.id));
    });

    it('should list all sessions for user without cursor', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.list({});

      expect(result.cliSessions).toHaveLength(3);
      expect(result.cliSessions[0]).toMatchObject({
        session_id: expect.any(String),
        title: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
        version: expect.any(Number),
      });
      expect(result.cliSessions[0]).toHaveProperty('organization_id');
      expect(result.cliSessions[0]).toHaveProperty('last_mode');
      expect(result.cliSessions[0]).toHaveProperty('last_model');
      expect(result.nextCursor).toBeNull();
    });

    it('should include version field in list response', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.list({});

      result.cliSessions.forEach(session => {
        expect(session).toHaveProperty('version');
        expect(typeof session.version).toBe('number');
      });
    });

    it('should include git_url in list response when set', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Create a session with git_url
      const sessionWithGitUrl = await caller.cliSessions.createV2({
        title: 'Session with Git URL',
        git_url: 'https://github.com/test/repo',
        created_on_platform: 'vscode',
      });

      const result = await caller.cliSessions.list({});

      const sessionInList = result.cliSessions.find(
        s => s.session_id === sessionWithGitUrl.session_id
      );
      expect(sessionInList).toBeDefined();
      expect(sessionInList!.git_url).toBe('https://github.com/test/repo');

      // Clean up
      await db.delete(cliSessions).where(eq(cliSessions.session_id, sessionWithGitUrl.session_id));
    });

    it('should return null git_url in list response when not set', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // The sessions created in beforeAll don't have git_url set
      const result = await caller.cliSessions.list({});

      // All sessions from beforeAll should have null git_url
      const sessionsWithoutGitUrl = result.cliSessions.filter(s =>
        s.title.startsWith('Test Session')
      );
      expect(sessionsWithoutGitUrl.length).toBeGreaterThan(0);
      sessionsWithoutGitUrl.forEach(session => {
        expect(session.git_url).toBeNull();
      });
    });

    it('should paginate sessions with cursor', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const firstPage = await caller.cliSessions.list({ limit: 2 });
      expect(firstPage.cliSessions).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await caller.cliSessions.list({
        cursor: firstPage.nextCursor!,
        limit: 2,
      });
      expect(secondPage.cliSessions).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
    });

    it('should respect custom limit', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.list({ limit: 1 });

      expect(result.cliSessions).toHaveLength(1);
      expect(result.nextCursor).not.toBeNull();
    });

    it('should not return sessions from other users', async () => {
      const caller = await createCallerForUser(otherUser.id);

      const result = await caller.cliSessions.list({});

      expect(result.cliSessions).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('should validate limit boundaries', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.cliSessions.list({ limit: 0 })).rejects.toThrow();
      await expect(caller.cliSessions.list({ limit: 101 })).rejects.toThrow();
    });
  });

  describe('search procedure', () => {
    let searchSessionId: string;

    beforeAll(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Unique Search Title',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      searchSessionId = session.session_id;
    });

    afterAll(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, searchSessionId));
    });

    it('should search sessions by title', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.search({ search_string: 'Unique Search' });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].title).toBe('Unique Search Title');
      expect(result.results[0]).toHaveProperty('version');
      expect(typeof result.results[0].version).toBe('number');
      expect(result.results[0]).toHaveProperty('organization_id');
      expect(result.results[0]).toHaveProperty('last_mode');
      expect(result.results[0]).toHaveProperty('last_model');
      expect(result.total).toBe(1);
    });

    it('should include version field in search results', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.search({ search_string: 'Unique Search' });

      result.results.forEach(session => {
        expect(session).toHaveProperty('version');
        expect(typeof session.version).toBe('number');
      });
    });

    it('should search sessions by session_id', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.search({
        search_string: searchSessionId.substring(0, 8),
      });

      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results.some(s => s.session_id === searchSessionId)).toBe(true);
    });

    it('should return empty results for non-matching search', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.search({
        search_string: 'NonExistentSessionTitle12345',
      });

      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should respect limit and offset', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const firstPage = await caller.cliSessions.search({
        search_string: 'Test',
        limit: 2,
        offset: 0,
      });

      const secondPage = await caller.cliSessions.search({
        search_string: 'Test',
        limit: 2,
        offset: 2,
      });

      expect(firstPage.offset).toBe(0);
      expect(secondPage.offset).toBe(2);
    });

    it('should validate search input', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.cliSessions.search({ search_string: '' })).rejects.toThrow();
      await expect(
        caller.cliSessions.search({ search_string: 'test', limit: 0 })
      ).rejects.toThrow();
      await expect(
        caller.cliSessions.search({ search_string: 'test', limit: 51 })
      ).rejects.toThrow();
      await expect(
        caller.cliSessions.search({ search_string: 'test', offset: -1 })
      ).rejects.toThrow();
    });
  });

  describe('create procedure', () => {
    it('should create a new session with required fields', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        created_on_platform: 'vscode',
      });

      expect(result).toMatchObject({
        session_id: expect.any(String),
        title: '',
        created_at: expect.any(String),
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.version).toBe(0);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should create a session with a specific version', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session with Version',
        created_on_platform: 'vscode',
        version: 5,
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.version).toBe(5);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should default version to 0 when not provided', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session without Version',
        created_on_platform: 'vscode',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.version).toBe(0);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should create a session with optional title and git_url', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'My Project',
        git_url: 'https://github.com/user/repo',
        created_on_platform: 'cli',
      });

      expect(result.title).toBe('My Project');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.git_url).toBe('https://github.com/user/repo');
      expect(session.created_on_platform).toBe('cli');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should create a session with last_mode', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session with Mode',
        created_on_platform: 'vscode',
        last_mode: 'code',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.last_mode).toBe('code');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should default last_mode to null when not provided', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session without Mode',
        created_on_platform: 'vscode',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.last_mode).toBeNull();

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should create a session with last_model', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session with Model',
        created_on_platform: 'vscode',
        last_model: 'anthropic/claude-sonnet-4',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.last_model).toBe('anthropic/claude-sonnet-4');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should default last_model to null when not provided', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session without Model',
        created_on_platform: 'vscode',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.last_model).toBeNull();

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should create a session with organization_id', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session with Org',
        created_on_platform: 'vscode',
        organization_id: testOrganization.id,
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.organization_id).toBe(testOrganization.id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    });

    it('should default organization_id to null when not provided', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session without Org',
        created_on_platform: 'vscode',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.organization_id).toBeNull();

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should sanitize git_url by stripping credentials and query params', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Sanitized URL Test',
        git_url: 'https://user:password@github.com/user/repo?token=secret#readme',
        created_on_platform: 'cli',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.git_url).toBe('https://github.com/user/repo');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should accept SSH git URLs', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'SSH URL Test',
        git_url: 'git@github.com:user/repo.git',
        created_on_platform: 'cli',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.git_url).toBe('git@github.com:user/repo.git');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should set git_url to null for invalid URLs', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Invalid URL Test',
        git_url: 'not-a-valid-url',
        created_on_platform: 'cli',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.git_url).toBeNull();

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should validate created_on_platform length', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.cliSessions.createV2({ created_on_platform: '' })).rejects.toThrow();

      await expect(
        caller.cliSessions.createV2({ created_on_platform: 'a'.repeat(101) })
      ).rejects.toThrow();
    });

    it('should create a session with organization_id when user is a member', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: otherUser.id,
        role: 'member',
      });

      const caller = await createCallerForUser(otherUser.id);

      const result = await caller.cliSessions.createV2({
        title: 'Session with Org - Member',
        created_on_platform: 'vscode',
        organization_id: testOrganization.id,
      });

      expect(result.organization_id).toBe(testOrganization.id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, otherUser.id)
          )
        );
    });

    it('should throw UNAUTHORIZED when creating session with organization_id user is not a member of', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.createV2({
          title: 'Session with Org - Not Member',
          created_on_platform: 'vscode',
          organization_id: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should create a session with parent_session_id when parent has no organization', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Create parent session without organization
      const parentSession = await caller.cliSessions.createV2({
        title: 'Parent Session',
        created_on_platform: 'vscode',
      });

      // Create child session with parent_session_id
      const result = await caller.cliSessions.createV2({
        title: 'Child Session',
        created_on_platform: 'vscode',
        parent_session_id: parentSession.session_id,
      });

      expect(result.parent_session_id).toBe(parentSession.session_id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
      await db.delete(cliSessions).where(eq(cliSessions.session_id, parentSession.session_id));
    });

    it('should create a session with parent_session_id when parent has organization and user is a member', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const caller = await createCallerForUser(regularUser.id);

      // Create parent session with organization
      const parentSession = await caller.cliSessions.createV2({
        title: 'Parent Session with Org',
        created_on_platform: 'vscode',
        organization_id: testOrganization.id,
      });

      // Create child session with parent_session_id
      const result = await caller.cliSessions.createV2({
        title: 'Child Session',
        created_on_platform: 'vscode',
        parent_session_id: parentSession.session_id,
      });

      expect(result.parent_session_id).toBe(parentSession.session_id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
      await db.delete(cliSessions).where(eq(cliSessions.session_id, parentSession.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    });

    it('should throw NOT_FOUND when creating session with parent_session_id where parent belongs to another user', async () => {
      // First, create the parent session directly in the database with organization
      const [parentSession] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Parent Session with Org',
          created_on_platform: 'vscode',
          organization_id: testOrganization.id,
        })
        .returning();

      // Add regularUser as a member of the organization
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      // Try to create child session as otherUser who doesn't own the parent session
      // Even though the parent has an organization, the user can't access it because they don't own the parent
      const otherUserCaller = await createCallerForUser(otherUser.id);

      await expect(
        otherUserCaller.cliSessions.createV2({
          title: 'Child Session',
          created_on_platform: 'vscode',
          parent_session_id: parentSession.session_id,
        })
      ).rejects.toThrow('Session not found');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, parentSession.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    });

    it('should throw NOT_FOUND when creating session with non-existent parent_session_id', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440099';

      await expect(
        caller.cliSessions.createV2({
          title: 'Child Session',
          created_on_platform: 'vscode',
          parent_session_id: nonExistentId,
        })
      ).rejects.toThrow('Session not found');
    });

    it('should throw NOT_FOUND when creating session with parent_session_id belonging to another user', async () => {
      const regularUserCaller = await createCallerForUser(regularUser.id);

      // Create parent session as regularUser
      const parentSession = await regularUserCaller.cliSessions.createV2({
        title: 'Parent Session',
        created_on_platform: 'vscode',
      });

      // Try to create child session as otherUser
      const otherUserCaller = await createCallerForUser(otherUser.id);

      await expect(
        otherUserCaller.cliSessions.createV2({
          title: 'Child Session',
          created_on_platform: 'vscode',
          parent_session_id: parentSession.session_id,
        })
      ).rejects.toThrow('Session not found');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, parentSession.session_id));
    });

    it('should sanitize null bytes from title to prevent PostgreSQL UTF-8 encoding errors', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // This title contains null bytes (0x00) which PostgreSQL rejects with:
      // "invalid byte sequence for encoding UTF8: 0x00"
      // Regression test for KILOCODE-WEB-5N2
      const titleWithNullBytes = 'Session with \x00 null \x00 bytes';

      const result = await caller.cliSessions.createV2({
        title: titleWithNullBytes,
        created_on_platform: 'vscode',
      });

      // The null bytes should be stripped
      expect(result.title).toBe('Session with  null  bytes');
      expect(result.title).not.toContain('\x00');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(session.title).toBe('Session with  null  bytes');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });
  });

  describe('get procedure', () => {
    let getSessionId: string;

    beforeAll(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Get Test Session',
          created_on_platform: 'vscode',
          api_conversation_history_blob_url: 'sessions/test/api_conversation_history.json',
          task_metadata_blob_url: 'sessions/test/task_metadata.json',
        })
        .returning({ session_id: cliSessions.session_id });

      getSessionId = session.session_id;
    });

    afterAll(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, getSessionId));
    });

    it('should get session without blob URLs', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.get({
        session_id: getSessionId,
        include_blob_urls: false,
      });

      expect(result).toMatchObject({
        session_id: getSessionId,
        title: 'Get Test Session',
        api_conversation_history_blob_url: 'sessions/test/api_conversation_history.json',
        task_metadata_blob_url: 'sessions/test/task_metadata.json',
      });
    });

    it('should get session with signed blob URLs', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.get({
        session_id: getSessionId,
        include_blob_urls: true,
      });

      expect(result.api_conversation_history_blob_url).toContain('signed-url.example.com');
      expect(result.task_metadata_blob_url).toContain('signed-url.example.com');
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440000';

      await expect(caller.cliSessions.get({ session_id: nonExistentId })).rejects.toThrow(
        'Session not found'
      );
    });

    it('should throw NOT_FOUND when accessing other user session', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(caller.cliSessions.get({ session_id: getSessionId })).rejects.toThrow(
        'Session not found'
      );
    });

    it('should validate session_id format', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.cliSessions.get({ session_id: 'invalid-uuid' })).rejects.toThrow();
    });
  });

  describe('update procedure', () => {
    let updateSessionId: string;

    beforeEach(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Original Title',
          git_url: 'https://github.com/original/repo',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      updateSessionId = session.session_id;
    });

    afterEach(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, updateSessionId));
    });

    it('should update session title', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Updated Title',
      });

      expect(result).toMatchObject({
        session_id: updateSessionId,
        title: 'Updated Title',
        updated_at: expect.any(String),
        version: expect.any(Number),
      });
    });

    it('should update session version', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        version: 10,
      });

      expect(result.version).toBe(10);

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.version).toBe(10);
    });

    it('should update title and version together', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Updated with Version',
        version: 15,
      });

      expect(result.title).toBe('Updated with Version');
      expect(result.version).toBe(15);
    });

    it('should update session git_url', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await caller.cliSessions.update({
        session_id: updateSessionId,
        git_url: 'https://github.com/updated/repo',
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.git_url).toBe('https://github.com/updated/repo');
    });

    it('should update both title and git_url', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Both Updated',
        git_url: 'https://github.com/both/updated',
      });

      expect(result.title).toBe('Both Updated');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.git_url).toBe('https://github.com/both/updated');
    });

    it('should update session last_mode', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        last_mode: 'architect',
      });

      expect(result.last_mode).toBe('architect');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.last_mode).toBe('architect');
    });

    it('should update title and last_mode together', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Updated with Mode',
        last_mode: 'debug',
      });

      expect(result.title).toBe('Updated with Mode');
      expect(result.last_mode).toBe('debug');
    });

    it('should update session last_model', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        last_model: 'openai/gpt-4',
      });

      expect(result.last_model).toBe('openai/gpt-4');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.last_model).toBe('openai/gpt-4');
    });

    it('should update title and last_model together', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Updated with Model',
        last_model: 'google/gemini-2.0-flash-exp',
      });

      expect(result.title).toBe('Updated with Model');
      expect(result.last_model).toBe('google/gemini-2.0-flash-exp');
    });

    it('should update session organization_id', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        organization_id: testOrganization.id,
      });

      expect(result.organization_id).toBe(testOrganization.id);

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.organization_id).toBe(testOrganization.id);

      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    });

    it('should update title and organization_id together', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: regularUser.id,
        role: 'owner',
      });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: 'Updated with Org',
        organization_id: testOrganization.id,
      });

      expect(result.title).toBe('Updated with Org');
      expect(result.organization_id).toBe(testOrganization.id);

      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, regularUser.id)
          )
        );
    });

    it('should throw error when no update fields provided', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.cliSessions.update({ session_id: updateSessionId })).rejects.toThrow(
        'At least one updatable field must be provided'
      );
    });

    it('should throw NOT_FOUND when updating other user session', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.update({
          session_id: updateSessionId,
          title: 'Should Fail',
        })
      ).rejects.toThrow('Session not found');
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440001';

      await expect(
        caller.cliSessions.update({
          session_id: nonExistentId,
          title: 'Should Fail',
        })
      ).rejects.toThrow('Session not found');
    });

    it('should update session when existing session has organization_id and user is a member', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: otherUser.id,
        role: 'member',
      });

      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: otherUser.id,
          title: 'Org Session',
          created_on_platform: 'vscode',
          organization_id: testOrganization.id,
        })
        .returning({ session_id: cliSessions.session_id });

      const caller = await createCallerForUser(otherUser.id);

      const result = await caller.cliSessions.update({
        session_id: session.session_id,
        title: 'Updated Org Session',
      });

      expect(result.title).toBe('Updated Org Session');
      expect(result.organization_id).toBe(testOrganization.id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, session.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, otherUser.id)
          )
        );
    });

    it('should throw UNAUTHORIZED when updating session with organization_id user is not a member of', async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: otherUser.id,
          title: 'Org Session',
          created_on_platform: 'vscode',
          organization_id: testOrganization.id,
        })
        .returning({ session_id: cliSessions.session_id });

      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.update({
          session_id: session.session_id,
          title: 'Should Fail',
        })
      ).rejects.toThrow('You do not have access to this organization');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, session.session_id));
    });

    it('should update session with new organization_id when user is a member of new org', async () => {
      await db.insert(organization_memberships).values({
        organization_id: testOrganization.id,
        kilo_user_id: otherUser.id,
        role: 'member',
      });

      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: otherUser.id,
          title: 'Session without Org',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      const caller = await createCallerForUser(otherUser.id);

      const result = await caller.cliSessions.update({
        session_id: session.session_id,
        organization_id: testOrganization.id,
      });

      expect(result.organization_id).toBe(testOrganization.id);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, session.session_id));
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, testOrganization.id),
            eq(organization_memberships.kilo_user_id, otherUser.id)
          )
        );
    });

    it('should throw UNAUTHORIZED when updating session with new organization_id user is not a member of', async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: otherUser.id,
          title: 'Session without Org',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.update({
          session_id: session.session_id,
          organization_id: testOrganization.id,
        })
      ).rejects.toThrow('You do not have access to this organization');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, session.session_id));
    });

    it('should sanitize null bytes from title to prevent PostgreSQL UTF-8 encoding errors', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // This title contains null bytes (0x00) which PostgreSQL rejects with:
      // "invalid byte sequence for encoding UTF8: 0x00"
      // Regression test for KILOCODE-WEB-5N2
      const titleWithNullBytes = 'Explain code from .rsrc\x00RCDATA\x00test \x00 content';

      const result = await caller.cliSessions.update({
        session_id: updateSessionId,
        title: titleWithNullBytes,
      });

      // The null bytes should be stripped
      expect(result.title).toBe('Explain code from .rsrcRCDATAtest  content');
      expect(result.title).not.toContain('\x00');

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, updateSessionId));

      expect(session.title).toBe('Explain code from .rsrcRCDATAtest  content');
    });
  });

  describe('delete procedure', () => {
    let deleteSessionId: string;

    beforeEach(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'To Be Deleted',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      deleteSessionId = session.session_id;
    });

    it('should delete session and its blobs', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');

      const result = await caller.cliSessions.delete({
        session_id: deleteSessionId,
      });

      expect(result).toEqual({
        success: true,
        session_id: deleteSessionId,
      });

      expect(deleteBlobs).toHaveBeenCalledWith(deleteSessionId, expect.any(Array));

      const sessions = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, deleteSessionId));

      expect(sessions).toHaveLength(0);
    });

    it('should attempt to delete linked cloud-agent session when present', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await db
        .update(cliSessions)
        .set({ cloud_agent_session_id: 'agent_test_session' })
        .where(eq(cliSessions.session_id, deleteSessionId));

      await caller.cliSessions.delete({ session_id: deleteSessionId });

      expect(deleteCloudAgentSessionMock).toHaveBeenCalledWith('agent_test_session');
      expect(deleteCloudAgentSessionMock).toHaveBeenCalledTimes(1);
    });

    it('should throw NOT_FOUND when deleting other user session', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(caller.cliSessions.delete({ session_id: deleteSessionId })).rejects.toThrow(
        'Session not found'
      );

      const sessions = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, deleteSessionId));

      expect(sessions).toHaveLength(1);
    });

    it('should throw NOT_FOUND for non-existent session', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440002';

      await expect(caller.cliSessions.delete({ session_id: nonExistentId })).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('share procedure', () => {
    let shareSessionId: string;

    beforeEach(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Session To Share',
          created_on_platform: 'vscode',
          api_conversation_history_blob_url: 'sessions/test/api_conversation_history.json',
        })
        .returning({ session_id: cliSessions.session_id });

      shareSessionId = session.session_id;
    });

    afterEach(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, shareSessionId));
      await db.delete(sharedCliSessions).where(eq(sharedCliSessions.session_id, shareSessionId));
    });

    it('should share a session as public', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const { copyBlobs } = await import('@/lib/r2/cli-sessions');

      const result = await caller.cliSessions.share({
        session_id: shareSessionId,
        shared_state: CliSessionSharedState.Public,
      });

      expect(result).toMatchObject({
        share_id: expect.any(String),
        session_id: shareSessionId,
      });

      expect(copyBlobs).toHaveBeenCalled();

      const [sharedSession] = await db
        .select()
        .from(sharedCliSessions)
        .where(eq(sharedCliSessions.share_id, result.share_id));

      expect(sharedSession).toMatchObject({
        session_id: shareSessionId,
        kilo_user_id: regularUser.id,
        shared_state: CliSessionSharedState.Public,
      });
    });

    it('should throw NOT_FOUND when sharing other user session', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.share({
          session_id: shareSessionId,
          shared_state: CliSessionSharedState.Public,
        })
      ).rejects.toThrow('Session not found');
    });

    it('should validate shared_state enum', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessions.share({
          session_id: shareSessionId,
          shared_state: 'invalid' as unknown as typeof CliSessionSharedState.Public,
        })
      ).rejects.toThrow();
    });
  });

  describe('fork procedure', () => {
    let originalSessionId: string;
    let sharedSessionId: string;

    beforeAll(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Original Session for Fork',
          created_on_platform: 'vscode',
          version: 7,
        })
        .returning({ session_id: cliSessions.session_id });

      originalSessionId = session.session_id;

      const [shared] = await db
        .insert(sharedCliSessions)
        .values({
          session_id: originalSessionId,
          kilo_user_id: regularUser.id,
          shared_state: 'public',
        })
        .returning({ share_id: sharedCliSessions.share_id });

      sharedSessionId = shared.share_id;
    });

    afterAll(async () => {
      await db.delete(sharedCliSessions).where(eq(sharedCliSessions.share_id, sharedSessionId));
      await db.delete(cliSessions).where(eq(cliSessions.session_id, originalSessionId));
    });

    afterEach(async () => {
      await db
        .delete(cliSessions)
        .where(
          and(
            eq(cliSessions.kilo_user_id, otherUser.id),
            eq(cliSessions.forked_from, originalSessionId)
          )
        );
    });

    it('should fork from a public shared session', async () => {
      const caller = await createCallerForUser(otherUser.id);
      const { copyBlobs } = await import('@/lib/r2/cli-sessions');

      const result = await caller.cliSessions.fork({
        share_or_session_id: sharedSessionId,
        created_on_platform: 'vscode',
      });

      expect(result).toMatchObject({
        session_id: expect.any(String),
      });

      expect(copyBlobs).toHaveBeenCalled();

      const [forkedSession] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(forkedSession).toMatchObject({
        kilo_user_id: otherUser.id,
        title: 'Forked from "Original Session for Fork"',
        forked_from: originalSessionId,
        version: 7,
      });
    });

    it('should copy version from source session when forking', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.fork({
        share_or_session_id: originalSessionId,
        created_on_platform: 'vscode',
      });

      const [forkedSession] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(forkedSession.version).toBe(7);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should fork from own session', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.fork({
        share_or_session_id: originalSessionId,
        created_on_platform: 'cli',
      });

      expect(result.session_id).not.toBe(originalSessionId);

      const [forkedSession] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(forkedSession.kilo_user_id).toBe(regularUser.id);
      expect(forkedSession.forked_from).toBe(originalSessionId);

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
    });

    it('should handle session without title in fork', async () => {
      const [noTitleSession] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: '',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.fork({
        share_or_session_id: noTitleSession.session_id,
        created_on_platform: 'vscode',
      });

      const [forkedSession] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, result.session_id));

      expect(forkedSession.title).toBe('Forked session');

      await db.delete(cliSessions).where(eq(cliSessions.session_id, result.session_id));
      await db.delete(cliSessions).where(eq(cliSessions.session_id, noTitleSession.session_id));
    });

    it('should throw NOT_FOUND when forking other user private session', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.fork({
          share_or_session_id: originalSessionId,
          created_on_platform: 'vscode',
        })
      ).rejects.toThrow('Session not found');
    });

    describe('sanitizeForPostgres', () => {
      it('should remove null bytes from strings', () => {
        expect(sanitizeForPostgres('hello\x00world')).toBe('helloworld');
      });

      it('should remove multiple null bytes', () => {
        expect(sanitizeForPostgres('a\x00b\x00c\x00d')).toBe('abcd');
      });

      it('should handle strings with no null bytes', () => {
        expect(sanitizeForPostgres('normal string')).toBe('normal string');
      });

      it('should handle empty strings', () => {
        expect(sanitizeForPostgres('')).toBe('');
      });

      it('should handle strings that are only null bytes', () => {
        expect(sanitizeForPostgres('\x00\x00\x00')).toBe('');
      });

      it('should handle the actual error case from KILOCODE-WEB-5N2', () => {
        // This is the pattern that caused the original error:
        // A Windows resource file path with binary content
        const problematicTitle = 'Explain code from .rsrc\x00\x00\x00RCDATA\x00\x00\x00test';
        expect(sanitizeForPostgres(problematicTitle)).toBe('Explain code from .rsrcRCDATAtest');
        expect(sanitizeForPostgres(problematicTitle)).not.toContain('\x00');
      });
    });

    describe('isValidGitUrl', () => {
      it('should accept HTTPS URLs', () => {
        expect(isValidGitUrl('https://github.com/org/repo')).toBe(true);
      });

      it('should accept HTTP URLs', () => {
        expect(isValidGitUrl('http://github.com/org/repo')).toBe(true);
      });

      it('should accept SSH URLs', () => {
        expect(isValidGitUrl('git@github.com:org/repo.git')).toBe(true);
      });

      it('should reject invalid URLs', () => {
        expect(isValidGitUrl('not-a-valid-url')).toBe(false);
      });

      it('should reject non-http protocols', () => {
        expect(isValidGitUrl('ftp://github.com/repo')).toBe(false);
      });
    });

    describe('sanitizeGitUrl', () => {
      it('should strip credentials from HTTPS URLs', () => {
        expect(sanitizeGitUrl('https://user:pass@github.com/org/repo')).toBe(
          'https://github.com/org/repo'
        );
      });

      it('should strip query params and hash from HTTPS URLs', () => {
        expect(sanitizeGitUrl('https://github.com/org/repo?token=abc#readme')).toBe(
          'https://github.com/org/repo'
        );
      });

      it('should strip all sensitive info from HTTPS URLs', () => {
        expect(sanitizeGitUrl('https://user:pass@github.com/org/repo.git?ref=main#L10')).toBe(
          'https://github.com/org/repo.git'
        );
      });

      it('should preserve SSH URLs without query params', () => {
        expect(sanitizeGitUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
      });

      it('should strip query params from SSH URLs', () => {
        expect(sanitizeGitUrl('git@github.com:org/repo.git?ref=main')).toBe(
          'git@github.com:org/repo.git'
        );
      });

      it('should handle SSH URLs with subgroups', () => {
        expect(sanitizeGitUrl('git@gitlab.com:group/subgroup/repo.git')).toBe(
          'git@gitlab.com:group/subgroup/repo.git'
        );
      });

      it('should return original for unparseable URLs', () => {
        expect(sanitizeGitUrl('some-random-string')).toBe('some-random-string');
      });

      it('should handle HTTP URLs', () => {
        expect(sanitizeGitUrl('http://github.com/org/repo')).toBe('http://github.com/org/repo');
      });
    });

    describe('parseGitUrl', () => {
      it('should return sanitized URL for valid HTTPS', () => {
        expect(parseGitUrl('https://user:pass@github.com/org/repo?token=abc')).toBe(
          'https://github.com/org/repo'
        );
      });

      it('should return sanitized URL for valid SSH', () => {
        expect(parseGitUrl('git@github.com:org/repo.git?ref=main')).toBe(
          'git@github.com:org/repo.git'
        );
      });

      it('should return undefined for invalid URLs', () => {
        expect(parseGitUrl('not-a-valid-url')).toBeUndefined();
      });

      it('should return undefined for non-http protocols', () => {
        expect(parseGitUrl('ftp://github.com/repo')).toBeUndefined();
      });
    });
  });

  describe('linkCloudAgent procedure', () => {
    let linkSessionId: string;

    beforeEach(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Session for Cloud Agent Link',
          created_on_platform: 'vscode',
        })
        .returning({ session_id: cliSessions.session_id });

      linkSessionId = session.session_id;
    });

    afterEach(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, linkSessionId));
    });

    it('should successfully link a cloud-agent session ID to an existing kilo session owned by the user', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const cloudAgentSessionId = 'cloud-agent-session-12345';

      const result = await caller.cliSessions.linkCloudAgent({
        kilo_session_id: linkSessionId,
        cloud_agent_session_id: cloudAgentSessionId,
      });

      expect(result).toEqual({ success: true });
    });

    it('should save cloud_agent_session_id in the database after linking', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const cloudAgentSessionId = 'cloud-agent-session-verify-db';

      await caller.cliSessions.linkCloudAgent({
        kilo_session_id: linkSessionId,
        cloud_agent_session_id: cloudAgentSessionId,
      });

      const [session] = await db
        .select()
        .from(cliSessions)
        .where(eq(cliSessions.session_id, linkSessionId));

      expect(session.cloud_agent_session_id).toBe(cloudAgentSessionId);
    });

    it('should return NOT_FOUND when session does not exist', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440099';

      await expect(
        caller.cliSessions.linkCloudAgent({
          kilo_session_id: nonExistentId,
          cloud_agent_session_id: 'some-cloud-agent-id',
        })
      ).rejects.toThrow('Kilo session not found');
    });

    it('should return NOT_FOUND when session belongs to a different user', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.linkCloudAgent({
          kilo_session_id: linkSessionId,
          cloud_agent_session_id: 'some-cloud-agent-id',
        })
      ).rejects.toThrow('Kilo session not found');
    });
  });

  describe('getByCloudAgentSessionId procedure', () => {
    let sessionWithCloudAgent: string;
    const testCloudAgentSessionId = 'test-cloud-agent-session-id-lookup';

    beforeEach(async () => {
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: regularUser.id,
          title: 'Session with Cloud Agent',
          created_on_platform: 'vscode',
          cloud_agent_session_id: testCloudAgentSessionId,
          git_url: 'https://github.com/test/repo',
        })
        .returning({ session_id: cliSessions.session_id });

      sessionWithCloudAgent = session.session_id;
    });

    afterEach(async () => {
      await db.delete(cliSessions).where(eq(cliSessions.session_id, sessionWithCloudAgent));
    });

    it('should successfully return session details when found', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.cliSessions.getByCloudAgentSessionId({
        cloud_agent_session_id: testCloudAgentSessionId,
      });

      expect(result).toMatchObject({
        session_id: sessionWithCloudAgent,
        title: 'Session with Cloud Agent',
        git_url: 'https://github.com/test/repo',
        cloud_agent_session_id: testCloudAgentSessionId,
        created_on_platform: 'vscode',
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it('should return NOT_FOUND when no session has the given cloud_agent_session_id', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.cliSessions.getByCloudAgentSessionId({
          cloud_agent_session_id: 'non-existent-cloud-agent-id',
        })
      ).rejects.toThrow('No kilo session found for this cloud-agent session');
    });

    it('should return NOT_FOUND when session with cloud_agent_session_id belongs to a different user', async () => {
      const caller = await createCallerForUser(otherUser.id);

      await expect(
        caller.cliSessions.getByCloudAgentSessionId({
          cloud_agent_session_id: testCloudAgentSessionId,
        })
      ).rejects.toThrow('No kilo session found for this cloud-agent session');
    });
  });
});
