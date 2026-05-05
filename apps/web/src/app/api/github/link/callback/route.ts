import type { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { APP_URL } from '@/lib/constants';
import { githubUserIdentity, linkKiloUser } from '@/lib/bot-identity';
import { verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import { bot } from '@/lib/bot';

function htmlPage(title: string, message: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    const signInUrl = new URL('/users/sign_in', APP_URL);
    signInUrl.searchParams.set('callbackPath', '/github/link');
    return Response.redirect(signInUrl.toString());
  }

  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = verifyGitHubBotLinkState(searchParams.get('state'));

  if (!code || !state) {
    return htmlPage(
      'Link Failed',
      'Invalid or expired GitHub link request. Please try again.',
      400
    );
  }

  if (state.userId !== user.id) {
    return htmlPage(
      'Link Failed',
      'This GitHub link request was started by another Kilo user.',
      403
    );
  }

  const githubUser = await exchangeGitHubOAuthCode(code, 'standard');

  await bot.initialize();
  await linkKiloUser(bot.getState(), githubUserIdentity(githubUser.id), user.id);

  return htmlPage(
    'GitHub account linked',
    `GitHub account ${githubUser.login} has been linked to your Kilo account.<br>You can return to GitHub and mention Kilo again.`
  );
}
