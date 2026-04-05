import type { NextRequest } from 'next/server';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

/**
 * GitHub Lite App Webhook Handler
 *
 * Read-only KiloConnect-Lite app for OSS-sponsored organizations.
 * Delegates to shared handler with 'lite' app type.
 */
export async function POST(request: NextRequest) {
  return handleGitHubWebhook(request, 'lite');
}
