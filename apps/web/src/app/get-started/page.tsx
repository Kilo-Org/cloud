import { buildLandingRedirectUrl } from '@/lib/landing-redirect';
import { browserLandingPath } from '@/lib/app-link-safe-redirect';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';
import { getProfileRedirectPath } from '@/lib/user/profile-redirect-path';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { redirect } from 'next/navigation';

export default async function GetStartedPage({ searchParams }: AppPageProps) {
  const { user } = await getUserFromAuth({
    adminOnly: false,
    DANGEROUS_allowBlockedUsers: true,
  });

  if (!user) {
    redirect(buildLandingRedirectUrl('/install', await searchParams));
  }

  if (isBlockedAccount(user)) {
    redirect('/account-blocked');
  }

  if (user.has_validation_stytch === null) {
    redirect('/account-verification');
  }

  redirect(browserLandingPath(maybeInterceptWithSurvey(user, await getProfileRedirectPath(user))));
}
