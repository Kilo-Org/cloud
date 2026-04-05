import type { Env } from '../types';
import { logger, formatError } from './logger';

export type PushNotificationParams = {
  repoId: string;
  commitHash: string;
  branch: string;
};

/**
 * Notify the backend of a git push event.
 * This is a fire-and-forget operation - errors are logged but don't fail the push.
 */
export async function notifyBackendOfPush(env: Env, params: PushNotificationParams): Promise<void> {
  const { repoId, commitHash, branch } = params;

  // Check if push notification URL is configured
  if (!env.BACKEND_PUSH_NOTIFICATION_URL) {
    logger.debug('Push notification skipped - BACKEND_PUSH_NOTIFICATION_URL not configured');
    return;
  }

  // Construct gitUrl from repoId using BUILDER_HOSTNAME
  const gitUrl = `https://${env.BUILDER_HOSTNAME}/apps/${repoId}.git`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add auth token if configured
  if (env.AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${env.AUTH_TOKEN}`;
  }

  const body = JSON.stringify({
    gitUrl,
    commitHash,
    branch,
  });

  try {
    const response = await fetch(env.BACKEND_PUSH_NOTIFICATION_URL, {
      method: 'POST',
      headers,
      body,
    });

    if (response.ok) {
      logger.debug('Push notification sent successfully', {
        commitHash,
        branch,
        status: response.status,
      });
    } else {
      const responseText = await response.text().catch(() => 'Unable to read response');
      logger.warn('Push notification failed', {
        commitHash,
        branch,
        status: response.status,
        response: responseText,
      });
    }
  } catch (error) {
    logger.error('Push notification error', formatError(error));
  }
}
