import type { NextRequest } from 'next/server';
import { handleGitHubWebhook } from '@/lib/integrations/platforms/github/webhook-handler';

/**
 * GitHub App Webhook Handler (Standard App)
 *
 * Full-featured KiloConnect app with read/write permissions.
 * Delegates to shared handler with 'standard' app type.
 */
export async function POST(request: NextRequest) {
  return handleGitHubWebhook(request, 'standard');
}
