import { NextRequest, NextResponse } from 'next/server';
import { findGitHubIntegrationByAccountLogin } from '@/lib/integrations/db/platform-integrations';
import * as Sentry from '@sentry/nextjs';

export async function GET(request: NextRequest) {
  try {
    const owner = request.nextUrl.searchParams.get('owner');
    if (!owner) {
      return NextResponse.json({ error: 'Missing owner parameter' }, { status: 400 });
    }

    const integration = await findGitHubIntegrationByAccountLogin(owner);
    const installed = !!(integration && integration.platform_installation_id);

    return NextResponse.json({ installation: installed });
  } catch (error) {
    console.error('GitHub installation check failed:', error);
    Sentry.captureException(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
