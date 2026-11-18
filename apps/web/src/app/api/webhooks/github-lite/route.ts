import type { NextRequest } from 'next/server';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

/**
 * Must stay strictly below GITHUB_INSTALLATION_DELIVERY_STALE_CLAIM_MS (10 minutes).
 * The shared handler reclaims a `processing` delivery receipt once it is older than
 * that window, so a dispatch allowed to run longer could be reclaimed and double-processed.
 */
export const maxDuration = 300;

/**
 * GitHub Lite App Webhook Handler
 *
 * Read-only KiloConnect-Lite app for OSS-sponsored organizations.
 * Delegates to shared handler with 'lite' app type.
 */
export async function POST(request: NextRequest) {
  return handleGitHubWebhook(request, 'lite');
}
