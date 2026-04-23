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
import { isCreditCampaignCallback, lookupCampaignBySlug } from '@/lib/credit-campaigns';

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
  const isValidCallback = callbackStr !== null && isValidCallbackPath(callbackStr);

  // Resolve signup attribution and strip `/c/<slug>` callbacks. Any credit-
  // campaign URL is a one-shot signup-entry URL; once the bonus has been
  // granted (or correctly skipped because the campaign doesn't exist / the
  // user was already validated) there's nothing useful for the landing page
  // to show the now-signed-in user beyond the "for new accounts" message. So
  // we route the user to `/get-started` instead — symmetric with the
  // dead-callback case and with any other generic signup.
  //
  // Attribution (setting `signupSource`) still requires the transition-to-new-
  // user guard (`isFirstValidation`) plus a DB confirmation that the slug
  // exists — that prevents a manually crafted `/c/<garbage>` from leaking a
  // phantom `credit-campaign` PostHog tag or triggering a useless grant call.
  // The strip decision is independent: it fires for every `/c/<slug>` callback
  // so the redirect on the post-validation pass (where `isFirstValidation` is
  // already false) still routes to `/get-started`.
  let signupSource: SignupSource = null;
  // Strip on ANY /c/ callback path, not just well-formed ones. Motivation:
  // isValidCallbackPath only checks `.startsWith('/c/')`, so a manually
  // crafted `/c/Summit` (uppercase) or `/c/xx` (too short) passes the
  // callback whitelist but fails the stricter isCreditCampaignCallback
  // slug-format guard. Without unconditional stripping, the redirect would
  // bounce the user to the malformed URL post-signup, which then routes to
  // `/` — a pointless extra hop. Stripping at the prefix level makes the
  // "all /c/ callbacks resolve to /get-started post-signup" invariant
  // hold universally.
  let stripCreditCampaignCallback = callbackStr !== null && callbackStr.startsWith('/c/');
  if (isValidCallback) {
    if (isOpenclawAdvisorCallback(callbackStr)) {
      if (isFirstValidation) signupSource = { kind: 'openclaw-security-advisor' };
    } else {
      const campaignMatch = isCreditCampaignCallback(callbackStr);
      if (campaignMatch) {
        stripCreditCampaignCallback = true;
        if (isFirstValidation) {
          const campaign = await lookupCampaignBySlug(campaignMatch.slug);
          if (campaign) {
            signupSource = { kind: 'credit-campaign', slug: campaignMatch.slug };
          }
        }
      }
    }
  }

  await handleSignupPromotion(user, stytchStatus || false, signupSource);

  if (stytchStatus !== null) {
    const hasUsableCallback = isValidCallback && !stripCreditCampaignCallback;
    const finalDestination = hasUsableCallback ? callbackStr : '/get-started';
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
