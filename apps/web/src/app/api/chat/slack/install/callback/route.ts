import { bot } from '@/lib/bot';
import { APP_URL } from '@/lib/constants';
import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { platform_integrations } from '@kilocode/db';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
  }

  await bot.initialize();
  const slackAdapter = bot.getAdapter('slack');

  // TODO(remon): Not completely sure why this is needed, but handleOAuthCallback
  //   requires a redirect_uri in the URL, and we don't have it (because we are the redirect_uri)
  const url = new URL(request.url);
  url.searchParams.set('redirect_uri', `${APP_URL}/api/chat/slack/install/callback`);
  const patchedRequest = new Request(url, request);

  const { teamId, installation } = await slackAdapter.handleOAuthCallback(patchedRequest);

  // TODO: HMAC-sign the state parameter when generating the install URL
  // and verify the signature here to prevent CSRF / tampering.
  const state = url?.searchParams.get('state');

  if (state?.startsWith('org_')) {
    const orgId = state.replace('org_', '');
    await ensureOrganizationAccess({ user }, orgId);

    await db.transaction(async tx => {
      await tx
        .delete(platform_integrations)
        .where(
          and(
            eq(platform_integrations.owned_by_organization_id, orgId),
            eq(platform_integrations.platform, PLATFORM.SLACK_NEXT)
          )
        );

      await tx.insert(platform_integrations).values({
        owned_by_organization_id: orgId,
        platform: PLATFORM.SLACK_NEXT,
        integration_type: 'oauth',
        platform_installation_id: teamId,
        platform_account_id: teamId,
        platform_account_login: installation.teamName,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: {},
        installed_at: new Date().toISOString(),
      });
    });
  } else {
    await db.transaction(async tx => {
      await tx
        .delete(platform_integrations)
        .where(
          and(
            eq(platform_integrations.owned_by_user_id, user.id),
            eq(platform_integrations.platform, PLATFORM.SLACK_NEXT)
          )
        );

      await tx.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        platform: PLATFORM.SLACK_NEXT,
        integration_type: 'oauth',
        platform_installation_id: teamId,
        platform_account_id: teamId,
        platform_account_login: installation.teamName,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata: {},
        installed_at: new Date().toISOString(),
      });
    });
  }

  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Slack Installed</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>Slack app installed</h1>
  <p>Kilo has been installed to your workspace. You can close this tab.</p>
</div>
</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}
