import { APP_URL } from '@/lib/constants';
import { SLACK_SCOPES } from '@/lib/integrations/slack-service';
import { getUserFromAuth } from '@/lib/user.server';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * Temporary admin-only route that redirects to the Slack OAuth flow
 * for the chat-adapter Slack app (SLACK_NEXT_*).
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const clientId = process.env.SLACK_NEXT_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'SLACK_NEXT_CLIENT_ID is not configured' }, { status: 500 });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${APP_URL}/api/chat/slack/install/callback`,
    scope: SLACK_SCOPES.join(','),
    state: requestUrl.searchParams.get('state') || '',
  });

  return NextResponse.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
}
