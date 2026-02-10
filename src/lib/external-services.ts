import { getEnvVariable } from '@/lib/dotenvx';
import 'server-only';

import { safeDeleteStripeCustomer } from './stripe-client';
import { captureException } from '@sentry/nextjs';
import type { User } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { cliSessions, sharedCliSessions, cli_sessions_v2 } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { deleteBlobs, type FileName } from '@/lib/r2/cli-sessions';
import { errorExceptInTest, logExceptInTest, warnExceptInTest } from '@/lib/utils.server';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET, SESSION_INGEST_WORKER_URL } from '@/lib/config.server';
import { JWT_TOKEN_VERSION } from '@/lib/tokens';

/**
 * Delete user from Customer.io
 * Customer.io API docs: https://customer.io/docs/api/track/#operation/delete
 */
async function deleteUserFromCustomerIO(email: string): Promise<void> {
  const siteId = getEnvVariable('CUSTOMERIO_SITE_ID');
  const apiKey = getEnvVariable('CUSTOMERIO_API_KEY');

  if (!siteId || !apiKey) {
    warnExceptInTest('Customer.io credentials not configured, skipping deletion');
    return;
  }

  try {
    const response = await fetch(`https://track.customer.io/api/v1/customers/${email}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${siteId}:${apiKey}`).toString('base64')}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Customer.io deletion failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 404) {
      logExceptInTest(`Customer ${email} not found in Customer.io, continuing with deletion`);
    } else {
      logExceptInTest(`Successfully deleted customer ${email} from Customer.io`);
    }
  } catch (error) {
    const message = `Failed to delete user from Customer.io for email ${email}: ${error instanceof Error ? error.message : String(error)}`;
    errorExceptInTest(message);
    captureException(error, {
      tags: { source: 'customerio-deletion' },
      extra: { email },
    });
  }
}

/**
 * Delete CLI session blobs from R2 storage
 */
async function deleteCliSessionBlobs(userId: string): Promise<void> {
  try {
    // Fetch all CLI sessions owned by the user
    const userCliSessions = await db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.kilo_user_id, userId));

    // Delete blobs for each CLI session
    for (const session of userCliSessions) {
      const blobsToDelete: Array<{ folderName: 'sessions'; filename: FileName }> = [];

      if (session.api_conversation_history_blob_url) {
        blobsToDelete.push({ folderName: 'sessions', filename: 'api_conversation_history' });
      }
      if (session.task_metadata_blob_url) {
        blobsToDelete.push({ folderName: 'sessions', filename: 'task_metadata' });
      }
      if (session.ui_messages_blob_url) {
        blobsToDelete.push({ folderName: 'sessions', filename: 'ui_messages' });
      }
      if (session.git_state_blob_url) {
        blobsToDelete.push({ folderName: 'sessions', filename: 'git_state' });
      }

      if (blobsToDelete.length > 0) {
        await deleteBlobs(session.session_id, blobsToDelete);
      }
    }

    // Fetch all shared CLI sessions owned by the user
    const userSharedSessions = await db
      .select()
      .from(sharedCliSessions)
      .where(eq(sharedCliSessions.kilo_user_id, userId));

    // Delete blobs for each shared session
    for (const sharedSession of userSharedSessions) {
      const blobsToDelete: Array<{ folderName: 'shared-sessions'; filename: FileName }> = [];

      if (sharedSession.api_conversation_history_blob_url) {
        blobsToDelete.push({ folderName: 'shared-sessions', filename: 'api_conversation_history' });
      }
      if (sharedSession.task_metadata_blob_url) {
        blobsToDelete.push({ folderName: 'shared-sessions', filename: 'task_metadata' });
      }
      if (sharedSession.ui_messages_blob_url) {
        blobsToDelete.push({ folderName: 'shared-sessions', filename: 'ui_messages' });
      }
      if (sharedSession.git_state_blob_url) {
        blobsToDelete.push({ folderName: 'shared-sessions', filename: 'git_state' });
      }

      if (blobsToDelete.length > 0) {
        await deleteBlobs(sharedSession.share_id, blobsToDelete);
      }
    }

    logExceptInTest(
      `Successfully deleted CLI session blobs for user: ${userId} (${userCliSessions.length} sessions, ${userSharedSessions.length} shared sessions)`
    );
  } catch (error) {
    const message = `Failed to delete CLI session blobs for user ${userId}: ${error instanceof Error ? error.message : String(error)}`;
    errorExceptInTest(message);
    captureException(error, {
      tags: { source: 'cli-sessions-deletion' },
      extra: { userId },
    });
  }
}

/**
 * Generate a minimal JWT token for internal GDPR deletion operations.
 * This token only contains the fields required by the session ingest worker.
 */
function generateGdprDeletionToken(userId: string): string {
  return jwt.sign(
    {
      kiloUserId: userId,
      version: JWT_TOKEN_VERSION,
    },
    NEXTAUTH_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '1h',
    }
  );
}

/**
 * Delete CLI session v2 blobs from the session ingest worker.
 * V2 sessions store their data in Durable Objects (SessionIngestDO) rather than R2.
 * This function calls the session ingest worker's delete endpoint for each session.
 */
async function deleteCliSessionV2Blobs(userId: string): Promise<void> {
  if (!SESSION_INGEST_WORKER_URL) {
    warnExceptInTest('SESSION_INGEST_WORKER_URL not configured, skipping v2 session blob deletion');
    return;
  }

  try {
    // Fetch all v2 CLI sessions owned by the user
    const userV2Sessions = await db
      .select({ session_id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.kilo_user_id, userId));

    if (userV2Sessions.length === 0) {
      logExceptInTest(`No v2 CLI sessions found for user: ${userId}`);
      return;
    }

    // Generate a token for the user to authenticate with the session ingest worker
    const token = generateGdprDeletionToken(userId);

    // Delete each session's Durable Object data via the session ingest worker
    let successCount = 0;
    let failCount = 0;

    for (const session of userV2Sessions) {
      try {
        const response = await fetch(
          `${SESSION_INGEST_WORKER_URL}/api/session/${encodeURIComponent(session.session_id)}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (response.ok || response.status === 404) {
          // 404 is acceptable - the session may have already been deleted
          successCount++;
        } else {
          const errorText = await response.text().catch(() => 'Unknown error');
          warnExceptInTest(
            `Failed to delete v2 session ${session.session_id}: ${response.status} ${errorText}`
          );
          failCount++;
        }
      } catch (error) {
        warnExceptInTest(
          `Error deleting v2 session ${session.session_id}: ${error instanceof Error ? error.message : String(error)}`
        );
        failCount++;
      }
    }

    logExceptInTest(
      `Deleted v2 CLI session blobs for user: ${userId} (${successCount} succeeded, ${failCount} failed out of ${userV2Sessions.length} sessions)`
    );
  } catch (error) {
    const message = `Failed to delete v2 CLI session blobs for user ${userId}: ${error instanceof Error ? error.message : String(error)}`;
    errorExceptInTest(message);
    captureException(error, {
      tags: { source: 'cli-sessions-v2-deletion' },
      extra: { userId },
    });
  }
}

/**
 * Delete user from all external services (Stripe, Customer.io, R2 blob storage)
 * This function is designed to be resilient - if one service fails, it will continue with the others
 */
export async function deleteUserFromExternalServices(user: User): Promise<void> {
  logExceptInTest(`Deleting user from external services: ${user.id}`);

  await safeDeleteStripeCustomer(user.stripe_customer_id);
  await deleteUserFromCustomerIO(user.google_user_email);
  await deleteCliSessionBlobs(user.id);
  await deleteCliSessionV2Blobs(user.id);

  logExceptInTest(`Completed external service deletions for user: ${user.id}`);
}
