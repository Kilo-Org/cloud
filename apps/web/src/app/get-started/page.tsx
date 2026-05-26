import { buildLandingRedirectUrl } from '@/lib/landing-redirect';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';
import { getProfileRedirectPath, getUserFromAuth } from '@/lib/user/server';
import { redirect } from 'next/navigation';

export default async function GetStartedPage({ searchParams }: AppPageProps) {
  const { user } = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });

  if (!user) {
    redirect(buildLandingRedirectUrl('/install', await searchParams));
  }

  if (user.blocked_reason) {
    redirect('/account-blocked');
  }

  if (user.has_validation_stytch === null) {
    redirect('/account-verification');
  }

  redirect(maybeInterceptWithSurvey(user, await getProfileRedirectPath(user)));
}
