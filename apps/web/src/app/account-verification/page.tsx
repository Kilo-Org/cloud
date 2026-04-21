import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { StytchClient } from '@/components/auth/StytchClient';
import { AnimatedLogo } from '@/components/AnimatedLogo';
import BigLoader from '@/components/BigLoader';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { getStytchStatus, handleSignupPromotion, type SignupSource } from '@/lib/stytch';
import { PageContainer } from '@/components/layouts/PageContainer';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { maybeInterceptWithSurvey } from '@/lib/survey-redirect';
import { isOpenclawAdvisorCallback } from '@/lib/signup-source';

export default async function AccountVerificationPage({ searchParams }: AppPageProps) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  // Capture whether the user was still unvalidated when they arrived. This
  // prevents an already-verified user from directly visiting
  // `/account-verification?callbackPath=/openclaw-advisor?code=...` to self-award
  // the signup bonus. The bonus must only fire on the transition from
  // null -> true, which is the real "new-user signup" event.
  const isFirstValidation = user.has_validation_stytch === null;
  const params = await searchParams;
  const telemetry_id = typeof params.telemetry_id === 'string' ? params.telemetry_id : null;
  const stytchStatus = await getStytchStatus(user, telemetry_id, await headers());

  const rawCallback = params.callbackPath;
  const callbackStr = typeof rawCallback === 'string' ? rawCallback : null;
  const signupSource: SignupSource =
    isFirstValidation &&
    callbackStr &&
    isValidCallbackPath(callbackStr) &&
    isOpenclawAdvisorCallback(callbackStr)
      ? 'openclaw-security-advisor'
      : null;

  await handleSignupPromotion(user, stytchStatus || false, signupSource);

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
