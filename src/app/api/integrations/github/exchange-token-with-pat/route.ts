import { NextRequest, NextResponse } from 'next/server';
import { Octokit } from '@octokit/rest';
import { findGitHubIntegrationByAccountLogin } from '@/lib/integrations/db/platform-integrations';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import * as Sentry from '@sentry/nextjs';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Missing authorization header' }, { status: 400 });
    }

    const pat = authHeader.substring(7);

    let body: { owner?: string; repo?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { owner, repo } = body;
    if (!owner || !repo) {
      return NextResponse.json({ error: 'Missing owner or repo in request body' }, { status: 400 });
    }

    const octokit = new Octokit({ auth: pat });

    try {
      await octokit.rest.repos.get({ owner, repo });
    } catch (error) {
      console.error('PAT validation failed:', error);
      return NextResponse.json(
        { error: 'Invalid PAT or no access to repository' },
        { status: 401 }
      );
    }

    const integration = await findGitHubIntegrationByAccountLogin(owner);

    if (!integration || !integration.platform_installation_id) {
      return NextResponse.json(
        { error: `No GitHub App installation found for owner ${owner}` },
        { status: 404 }
      );
    }

    const { token } = await generateGitHubInstallationToken(
      integration.platform_installation_id,
      integration.github_app_type || 'standard'
    );

    return NextResponse.json({ token });
  } catch (error) {
    console.error('GitHub token exchange with PAT failed:', error);
    Sentry.captureException(error);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
