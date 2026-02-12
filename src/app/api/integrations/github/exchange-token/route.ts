import { NextRequest, NextResponse } from 'next/server';
import { verifyGitHubOIDCToken } from '@/lib/integrations/platforms/github/oidc';
import { findGitHubIntegrationByAccountLogin } from '@/lib/integrations/db/platform-integrations';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import * as Sentry from '@sentry/nextjs';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing authorization header' }, { status: 400 });
    }

    const oidcToken = authHeader.substring(7);

    const payload = await verifyGitHubOIDCToken(oidcToken, 'kilo-github-action');

    const repositoryOwner = payload.repository_owner;

    const integration = await findGitHubIntegrationByAccountLogin(repositoryOwner);

    if (!integration || !integration.platform_installation_id) {
      return NextResponse.json(
        { error: `No GitHub App installation found for owner ${repositoryOwner}` },
        { status: 404 }
      );
    }

    const { token } = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      integration.github_app_type || 'standard'
    );

    return NextResponse.json({ token });
  } catch (error) {
    console.error('GitHub token exchange failed:', error);
    Sentry.captureException(error);

    if (error instanceof Error && error.message.includes('OIDC token verification failed')) {
      return NextResponse.json({ error: 'Invalid OIDC token' }, { status: 401 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
