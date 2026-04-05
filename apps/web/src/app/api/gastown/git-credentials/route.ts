/**
 * Internal API: Resolve git credentials from a platform integration.
 *
 * Called by the gastown container at agent startup to get fresh GitHub/GitLab
 * tokens for cloning and pushing. This endpoint runs on the Next.js server
 * which has access to the DB and GitHub App private key.
 *
 * Auth: Bearer token (KILOCODE_TOKEN — the same token agents use for the gateway)
 *
 * POST /api/gastown/git-credentials
 * Body: { platform_integration_id: string }
 * Response: { github_token?: string, gitlab_token?: string, gitlab_instance_url?: string }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveGitCredentialsFromIntegration } from '@/lib/gastown/git-credentials';
import { validateAuthorizationHeader } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import { platform_integrations } from '@kilocode/db';

export async function POST(request: NextRequest) {
  // Verify auth — accept any valid Kilo API token
  const authResult = validateAuthorizationHeader(request.headers);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const platformIntegrationId = body?.platform_integration_id;
  if (!platformIntegrationId || typeof platformIntegrationId !== 'string') {
    return NextResponse.json({ error: 'platform_integration_id is required' }, { status: 400 });
  }

  // Verify the caller owns this integration
  const [integration] = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.id, platformIntegrationId),
        eq(platform_integrations.owned_by_user_id, authResult.kiloUserId)
      )
    )
    .limit(1);

  if (!integration) {
    return NextResponse.json(
      { error: 'Integration not found or not owned by this user' },
      { status: 403 }
    );
  }

  const credentials = await resolveGitCredentialsFromIntegration(platformIntegrationId);
  if (!credentials) {
    return NextResponse.json(
      { error: 'Could not resolve credentials for this integration' },
      { status: 404 }
    );
  }

  return NextResponse.json(credentials);
}
