import { db } from '@/lib/drizzle';
import { cliSessions, sharedCliSessions, cli_sessions_v2, kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { deleteUserFromExternalServices } from './external-services';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@/db/schema';

// Mock the external dependencies
jest.mock('./stripe-client', () => ({
  safeDeleteStripeCustomer: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/r2/cli-sessions', () => ({
  deleteBlobs: jest.fn().mockResolvedValue(undefined),
}));

// Mock config.server to provide SESSION_INGEST_WORKER_URL
jest.mock('@/lib/config.server', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/config.server');
  return {
    ...actual,
    SESSION_INGEST_WORKER_URL: 'https://ingest.kilosessions.ai',
  };
});

// Mock Customer.io API
global.fetch = jest.fn();

describe('external-services', () => {
  let testUser: User;

  beforeEach(async () => {
    testUser = await insertTestUser({
      google_user_email: 'test-external-services@example.com',
      google_user_name: 'Test External Services User',
    });

    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });
  });

  afterEach(async () => {
    // Clean up CLI sessions
    await db.delete(cliSessions).where(eq(cliSessions.kilo_user_id, testUser.id));
    await db.delete(sharedCliSessions).where(eq(sharedCliSessions.kilo_user_id, testUser.id));
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, testUser.id));
    // Clean up user
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUser.id));
  });

  describe('deleteUserFromExternalServices', () => {
    it('should delete CLI session blobs when user has sessions', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');

      // Create CLI sessions with blob URLs
      const [session1] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: testUser.id,
          title: 'Test Session 1',
          created_on_platform: 'vscode',
          api_conversation_history_blob_url: 'sessions/test1/api_conversation_history.json',
          task_metadata_blob_url: 'sessions/test1/task_metadata.json',
        })
        .returning();

      const [session2] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: testUser.id,
          title: 'Test Session 2',
          created_on_platform: 'vscode',
          ui_messages_blob_url: 'sessions/test2/ui_messages.json',
          git_state_blob_url: 'sessions/test2/git_state.json',
        })
        .returning();

      await deleteUserFromExternalServices(testUser);

      // Verify deleteBlobs was called for each session
      expect(deleteBlobs).toHaveBeenCalledTimes(2);

      // Verify first session blobs
      expect(deleteBlobs).toHaveBeenCalledWith(session1.session_id, [
        { folderName: 'sessions', filename: 'api_conversation_history' },
        { folderName: 'sessions', filename: 'task_metadata' },
      ]);

      // Verify second session blobs
      expect(deleteBlobs).toHaveBeenCalledWith(session2.session_id, [
        { folderName: 'sessions', filename: 'ui_messages' },
        { folderName: 'sessions', filename: 'git_state' },
      ]);
    });

    it('should delete shared CLI session blobs when user has shared sessions', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');

      // Create a regular session first
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: testUser.id,
          title: 'Session to Share',
          created_on_platform: 'vscode',
        })
        .returning();

      // Create shared sessions with blob URLs
      const [sharedSession1] = await db
        .insert(sharedCliSessions)
        .values({
          session_id: session.session_id,
          kilo_user_id: testUser.id,
          shared_state: 'public',
          api_conversation_history_blob_url: 'shared-sessions/share1/api_conversation_history.json',
          task_metadata_blob_url: 'shared-sessions/share1/task_metadata.json',
        })
        .returning();

      const [sharedSession2] = await db
        .insert(sharedCliSessions)
        .values({
          session_id: session.session_id,
          kilo_user_id: testUser.id,
          shared_state: 'public',
          ui_messages_blob_url: 'shared-sessions/share2/ui_messages.json',
        })
        .returning();

      await deleteUserFromExternalServices(testUser);

      // Verify deleteBlobs was called for shared sessions
      expect(deleteBlobs).toHaveBeenCalledWith(sharedSession1.share_id, [
        { folderName: 'shared-sessions', filename: 'api_conversation_history' },
        { folderName: 'shared-sessions', filename: 'task_metadata' },
      ]);

      expect(deleteBlobs).toHaveBeenCalledWith(sharedSession2.share_id, [
        { folderName: 'shared-sessions', filename: 'ui_messages' },
      ]);
    });

    it('should handle sessions with no blob URLs', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');

      // Create session without any blob URLs
      await db.insert(cliSessions).values({
        kilo_user_id: testUser.id,
        title: 'Session without blobs',
        created_on_platform: 'vscode',
      });

      await deleteUserFromExternalServices(testUser);

      // deleteBlobs should not be called for sessions without blobs
      expect(deleteBlobs).not.toHaveBeenCalled();
    });

    it('should handle sessions with partial blob URLs', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');

      // Create session with only some blob URLs
      const [session] = await db
        .insert(cliSessions)
        .values({
          kilo_user_id: testUser.id,
          title: 'Session with partial blobs',
          created_on_platform: 'vscode',
          api_conversation_history_blob_url: 'sessions/partial/api_conversation_history.json',
          // task_metadata_blob_url is null
          // ui_messages_blob_url is null
          git_state_blob_url: 'sessions/partial/git_state.json',
        })
        .returning();

      await deleteUserFromExternalServices(testUser);

      // Verify only the existing blobs are included
      expect(deleteBlobs).toHaveBeenCalledWith(session.session_id, [
        { folderName: 'sessions', filename: 'api_conversation_history' },
        { folderName: 'sessions', filename: 'git_state' },
      ]);
    });

    it('should continue with other deletions if CLI session blob deletion fails', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');
      const { safeDeleteStripeCustomer } = await import('./stripe-client');
      const { captureException } = await import('@sentry/nextjs');

      // Mock deleteBlobs to throw an error
      (deleteBlobs as jest.Mock).mockRejectedValueOnce(new Error('R2 deletion failed'));

      // Create a session
      await db.insert(cliSessions).values({
        kilo_user_id: testUser.id,
        title: 'Test Session',
        created_on_platform: 'vscode',
        api_conversation_history_blob_url: 'sessions/test/api_conversation_history.json',
      });

      // Should not throw
      await expect(deleteUserFromExternalServices(testUser)).resolves.not.toThrow();

      // Verify error was captured
      expect(captureException).toHaveBeenCalled();

      // Verify other services were still called
      expect(safeDeleteStripeCustomer).toHaveBeenCalled();
    });

    it('should handle user with no CLI sessions', async () => {
      const { deleteBlobs } = await import('@/lib/r2/cli-sessions');
      const { safeDeleteStripeCustomer } = await import('./stripe-client');

      await deleteUserFromExternalServices(testUser);

      // deleteBlobs should not be called
      expect(deleteBlobs).not.toHaveBeenCalled();

      // Other services should still be called
      expect(safeDeleteStripeCustomer).toHaveBeenCalled();
    });

    it('should call all external services in correct order', async () => {
      const { safeDeleteStripeCustomer } = await import('./stripe-client');

      await deleteUserFromExternalServices(testUser);

      // Verify Stripe service was called
      expect(safeDeleteStripeCustomer).toHaveBeenCalledWith(testUser.stripe_customer_id);
    });

    describe('v2 session blob deletion', () => {
      it('should delete v2 CLI session blobs via session ingest worker', async () => {
        // Create v2 CLI sessions
        await db.insert(cli_sessions_v2).values({
          session_id: 'ses_test1234567890123456789',
          kilo_user_id: testUser.id,
        });

        await db.insert(cli_sessions_v2).values({
          session_id: 'ses_test2345678901234567890',
          kilo_user_id: testUser.id,
        });

        // Mock successful deletion responses
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          status: 200,
        });

        await deleteUserFromExternalServices(testUser);

        // Verify fetch was called for each v2 session (plus Customer.io call)
        const fetchCalls = (global.fetch as jest.Mock).mock.calls;
        const v2SessionCalls = fetchCalls.filter(
          (call: [string, RequestInit]) =>
            call[0].includes('ingest.kilosessions.ai') && call[1]?.method === 'DELETE'
        );

        expect(v2SessionCalls.length).toBe(2);
        const v2SessionUrls = v2SessionCalls.map((call: [string, RequestInit]) => call[0]).sort();
        expect(v2SessionUrls[0]).toContain('ses_test1234567890123456789');
        expect(v2SessionUrls[1]).toContain('ses_test2345678901234567890');
      });

      it('should handle 404 responses gracefully for v2 sessions', async () => {
        await db.insert(cli_sessions_v2).values({
          session_id: 'ses_notfound12345678901234',
          kilo_user_id: testUser.id,
        });

        // Mock 404 response (session already deleted)
        (global.fetch as jest.Mock).mockImplementation((url: string) => {
          if (url.includes('ingest.kilosessions.ai')) {
            return Promise.resolve({
              ok: false,
              status: 404,
              text: () => Promise.resolve('Not found'),
            });
          }
          return Promise.resolve({ ok: true, status: 200 });
        });

        // Should not throw
        await expect(deleteUserFromExternalServices(testUser)).resolves.not.toThrow();
      });

      it('should continue with other deletions if v2 session deletion fails', async () => {
        const { safeDeleteStripeCustomer } = await import('./stripe-client');

        await db.insert(cli_sessions_v2).values({
          session_id: 'ses_failtest123456789012',
          kilo_user_id: testUser.id,
        });

        // Mock failed response
        (global.fetch as jest.Mock).mockImplementation((url: string) => {
          if (url.includes('ingest.kilosessions.ai')) {
            return Promise.resolve({
              ok: false,
              status: 500,
              text: () => Promise.resolve('Internal error'),
            });
          }
          return Promise.resolve({ ok: true, status: 200 });
        });

        // Should not throw
        await expect(deleteUserFromExternalServices(testUser)).resolves.not.toThrow();

        // Other services should still be called
        expect(safeDeleteStripeCustomer).toHaveBeenCalled();
      });

      it('should handle user with no v2 CLI sessions', async () => {
        await deleteUserFromExternalServices(testUser);

        // Verify no v2 session deletion calls were made
        const fetchCalls = (global.fetch as jest.Mock).mock.calls;
        const v2SessionCalls = fetchCalls.filter(
          (call: [string, RequestInit]) =>
            call[0].includes('ingest.kilosessions.ai') && call[1]?.method === 'DELETE'
        );

        expect(v2SessionCalls.length).toBe(0);
      });
    });
  });
});
