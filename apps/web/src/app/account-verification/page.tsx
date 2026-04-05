import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { StytchClient } from '@/components/auth/StytchClient';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import BigLoader from '@/components/BigLoader';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { getStytchStatus, handleSignupPromotion } from '@/lib/stytch';
import { PageContainer } from '@/components/layouts/PageContainer';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';

export default async function AccountVerificationPage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const params = await searchParams;
  const telemetry_id = typeof params.telemetry_id === 'string' ? params.telemetry_id : null;
  const stytchStatus = await getStytchStatus(user, telemetry_id, await headers());

  await handleSignupPromotion(user, stytchStatus || false);

  if (stytchStatus !== null) {
    const callbackPath = params.callbackPath;
    const hasValidCallback =
      callbackPath && typeof callbackPath === 'string' && isValidCallbackPath(callbackPath);

    const finalDestination = hasValidCallback ? callbackPath : '/get-started';
    redirect(maybeInterceptWithSurvey(user, finalDestination));
  }

  return (
    <PageContainer>
      <div className="flex min-h-screen flex-col items-center justify-between gap-12">
        <div className="self-start">
          <AnimatedLogo />
        </div>
        {stytchStatus === null && (
          <Suspense fallback={null}>
            <StytchClient />
          </Suspense>
        )}
        <BigLoader title="Creating Your Account" />
        <div className="text-muted-foreground flex items-center justify-center text-xs">
          © {new Date().getFullYear()} Kilo Code
        </div>
      </div>
    </PageContainer>
  );
}
