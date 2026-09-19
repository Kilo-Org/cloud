'use client';

import { MagicLinkSentConfirmation } from '@/components/auth/MagicLinkSentConfirmation';
import { useSignInFlow } from '@/hooks/useSignInFlow';
import { TurnstileView } from '@/components/auth/sign-in/TurnstileView';
import { ProviderSelectView } from '@/components/auth/sign-in/ProviderSelectView';
import { EmailInputForm } from '@/components/auth/sign-in/EmailInputForm';
import { AuthProviderButtons } from '@/components/auth/sign-in/AuthProviderButtons';
import { PasskeySignInButton } from '@/components/auth/sign-in/PasskeySignInButton';
import { SignInButton } from '@/components/auth/SigninButton';
import { Separator } from '@/components/ui/separator';
import { FakeLoginForm } from '@/components/auth/FakeLoginForm';
import { AuthErrorNotification } from '@/components/auth/AuthErrorNotification';
import { AnimatedLogoMark } from '@/components/AnimatedLogoMark';
import Link from 'next/link';
import { SquareUserRound } from 'lucide-react';
import React from 'react';
import type { SignInFormInitialState } from '@/hooks/useSignInFlow';
import { useChatGptSignInAccess } from '@/hooks/useChatGptSignInAccess';
import { OAuthProviderIds, type AuthProviderId } from '@/lib/auth/provider-metadata';
import { buildEnterpriseSsoHref, buildNormalSignInHref } from '@/lib/auth/sign-in-navigation';
import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';

/**
 * 'Sign in with ChatGPT' is restricted by the PostHog flag's email allow-list.
 * A signed-out visitor is not known to PostHog, so the sign-in page evaluates
 * the flag against the email the visitor typed and hides the ChatGPT button
 * when the flag is off for that email.
 */
function withoutChatGptWhenUnavailable(
  providers: readonly AuthProviderId[],
  chatGptAllowed: boolean
): AuthProviderId[] {
  return chatGptAllowed ? [...providers] : providers.filter(id => id !== 'openai');
}

type SignInFormProps = {
  searchParams: Record<string, string>;
  error?: string;
  isSignUp?: boolean;
  allowFakeLogin?: boolean;
  title?: string;
  subtitle?: string;
  emailOnly?: boolean; // If true, only show email input (for SSO page)
  ssoMode?: boolean; // If true, triggers SSO-specific messaging and email input view
  storybookInitialState?: SignInFormInitialState;
};

export function SignInForm({
  searchParams,
  error: initialError,
  isSignUp = false,
  allowFakeLogin = false,
  title,
  subtitle,
  emailOnly = false,
  ssoMode = false,
  storybookInitialState,
}: SignInFormProps) {
  const flow = useSignInFlow({
    searchParams,
    error: initialError,
    ssoMode,
    isSignUp,
    storybookInitialState,
  });
  // The ChatGPT option is decided from the address the visitor submits, or from
  // an address already known without typing. A `?email=` prefill wins over a
  // stored returning-user hint: the flow auto-triggers Turnstile for the
  // prefill and shows it on the provider screen, so the prefill is the address
  // in use. Typing alone never evaluates, so one address costs one reload.
  const [submittedEmail, setSubmittedEmail] = React.useState<string | null>(null);
  const knownEmail = (searchParams.email || flow.hint?.lastEmail || '').trim();
  const chatGptAllowed = useChatGptSignInAccess(submittedEmail ?? (knownEmail || null));
  const handleEmailSubmit = (event: React.FormEvent) => {
    setSubmittedEmail(flow.email);
    flow.handleEmailSubmit(event);
  };

  // Show minimal loading state while checking localStorage for returning user hint
  // This prevents flash of "new user" UI before switching to "returning user" UI
  if (!flow.isHintLoaded) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <AnimatedLogoMark size={56} className="mb-6 opacity-0" />
        {title && (
          <h1 className="text-foreground mb-2 text-3xl font-bold tracking-tight opacity-0 transition-opacity duration-300">
            {title}
          </h1>
        )}
      </div>
    );
  }

  const errorNotification = flow.error ? <AuthErrorNotification error={flow.error} /> : null;

  // Turnstile overlay
  if (flow.showTurnstile) {
    return (
      <TurnstileView
        email={flow.email}
        pendingSignIn={flow.pendingSignIn}
        turnstileError={flow.turnstileError}
        isVerifying={flow.isVerifying}
        isDeliveringMagicLink={flow.isDeliveringMagicLink}
        attemptId={flow.turnstileAttemptId}
        onSuccess={flow.handleTurnstileSuccess}
        onError={flow.handleTurnstileError}
        onBack={flow.handleBack}
        onRetry={flow.handleRetryTurnstile}
        backButtonText={'sign in options'}
      />
    );
  }

  // Magic link sent confirmation state
  if (flow.flowState === 'magic-link-sent') {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <AnimatedLogoMark size={56} className="mb-6" />
        {title && (
          <h1 className="text-foreground mb-8 text-3xl font-bold tracking-tight">{title}</h1>
        )}
        <MagicLinkSentConfirmation email={flow.email} onBack={flow.handleBack} />
      </div>
    );
  }

  // Redirecting state
  if (flow.flowState === 'redirecting') {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <AnimatedLogoMark size={56} className="mb-6" />
        <h1 className="text-foreground mb-3 text-3xl font-bold tracking-tight">Redirecting…</h1>
        <p className="text-muted-foreground text-sm">Taking you to your sign-in page…</p>
      </div>
    );
  }

  // Provider select state (after email lookup)
  if (flow.flowState === 'provider-select') {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <AnimatedLogoMark size={56} className="mb-6" />
        {title && (
          <h1 className="text-foreground mb-8 text-3xl font-bold tracking-tight">{title}</h1>
        )}
        {errorNotification}
        <ProviderSelectView
          email={flow.email}
          providers={withoutChatGptWhenUnavailable(flow.availableProviders, chatGptAllowed)}
          onProviderSelect={flow.handleProviderSelect}
          onBack={flow.handleBack}
          purpose={flow.isNewUser ? 'sign-up' : 'sign-in'}
        />
      </div>
    );
  }

  // Landing state - render based on tier
  // ────────────────────────────────────

  // A passkey sign-in lands where the other providers land.
  const passkeyCallbackUrl = getSignInCallbackUrl(searchParams);

  return (
    <>
      {allowFakeLogin && <FakeLoginForm searchParams={searchParams} />}
      <div className="mx-auto flex w-full max-w-sm flex-col items-center text-center">
        <AnimatedLogoMark size={56} className="mb-6" />

        {title && (
          <h1 className="text-foreground mb-2 text-3xl font-bold tracking-tight transition-all duration-300 ease-in-out">
            {title}
          </h1>
        )}

        {subtitle && !flow?.hint && (
          <p className="text-muted-foreground mb-8 text-sm leading-relaxed">{subtitle}</p>
        )}

        {errorNotification}

        {/* Content area with min-height to prevent layout shift */}
        <div className="min-h-[200px] transition-all duration-300">
          {/* Tier 1: Returning User (hide if showing email input) */}
          {flow.tier === 'returning' && flow.hint && !flow.showEmailInput && (
            <>
              {/* Show welcome message with email if available */}
              {flow.hint.lastEmail ? (
                <>
                  <p className="text-muted-foreground mb-1 text-lg">Welcome back</p>
                  <p className="text-foreground mb-2 text-xl font-medium">{flow.hint.lastEmail}</p>
                  <button
                    onClick={flow.handleClearHint}
                    className="text-muted-foreground mb-8 cursor-pointer text-sm hover:underline"
                  >
                    Not you? Use a different account
                  </button>
                </>
              ) : (
                /* Partial hint - no email, just show welcome without email */
                <p className="text-muted-foreground mb-8 text-lg">Welcome back</p>
              )}

              {(() => {
                const hint = flow.hint;
                const lastAuthMethod = hint.lastAuthMethod;

                if (lastAuthMethod === 'workos' && hint.orgId) {
                  // SSO user - no "other methods" discovery, so the SSO button is
                  // the whole list of remembered methods; a passkey the user
                  // registered is offered beside it rather than behind a link.
                  const orgId = hint.orgId;
                  return (
                    <div className="mx-auto max-w-md space-y-4">
                      <SignInButton onClick={() => flow.handleSSOContinue(orgId)}>
                        Sign in with Enterprise SSO
                      </SignInButton>
                      <PasskeySignInButton callbackUrl={passkeyCallbackUrl} />
                    </div>
                  );
                }

                // Non-SSO user - show preferred provider with optional "other methods"
                // If email provider and we have their email, show "Email me a magic link" instead
                const emailCustomLabel =
                  lastAuthMethod === 'email' && hint.lastEmail
                    ? { email: 'Email me a magic link' }
                    : undefined;

                // A returning ChatGPT user keeps the shortcut only while the
                // flag allows it; otherwise the full, filtered group is offered
                // so they are not left with a single hidden button.
                const preferredProviders = withoutChatGptWhenUnavailable(
                  [lastAuthMethod],
                  chatGptAllowed
                );
                const displayedProviders =
                  preferredProviders.length > 0
                    ? preferredProviders
                    : withoutChatGptWhenUnavailable(OAuthProviderIds, chatGptAllowed);

                return (
                  <div className="mx-auto max-w-md space-y-4">
                    {/* A passkey sits beside the remembered provider, never replacing it */}
                    <PasskeySignInButton callbackUrl={passkeyCallbackUrl} />

                    {/* Preferred provider button only */}
                    <AuthProviderButtons
                      providers={displayedProviders}
                      onProviderClick={flow.handleOAuthClick}
                      customLabels={emailCustomLabel}
                    />

                    <button
                      onClick={flow.handleClearHint}
                      className="text-muted-foreground text-sm hover:underline"
                    >
                      or see other sign-in methods
                    </button>
                  </div>
                );
              })()}
            </>
          )}

          {/* Email input for returning user who clicked "Continue with Email" but has no email saved */}
          {flow.tier === 'returning' && flow.showEmailInput && (
            <>
              <EmailInputForm
                email={flow.email}
                emailValidation={flow.emailValidation}
                onSubmit={handleEmailSubmit}
                onEmailChange={flow.handleEmailChange}
                placeholder="you@example.com"
                autoFocus={true}
                isLoading={flow.showTurnstile || flow.isVerifying}
              />
              <button
                onClick={flow.handleBack}
                className="text-muted-foreground mt-6 text-sm hover:underline"
              >
                ← Back to sign in options
              </button>
            </>
          )}

          {/* Tier 3: Invite */}
          {flow.tier === 'invite' &&
            flow.inviteOrgId &&
            (() => {
              const inviteOrgId = flow.inviteOrgId;
              return (
                <>
                  <p className="text-muted-foreground mb-1 text-lg">Signing you in to</p>
                  <p className="text-foreground mb-8 text-xl font-medium">
                    {flow.inviteOrgName || inviteOrgId}
                  </p>
                  <div className="mx-auto max-w-md space-y-4">
                    <SignInButton onClick={() => flow.handleSSOContinue(inviteOrgId)}>
                      Continue to Single Sign-On
                    </SignInButton>
                  </div>
                  <button
                    onClick={flow.handleClearInvite}
                    className="text-muted-foreground mt-6 cursor-pointer text-sm hover:underline"
                  >
                    Use a different account
                  </button>
                </>
              );
            })()}

          {/* Tier 2: New User (default) */}
          {flow.tier === 'new' && (
            <>
              {!isSignUp || emailOnly || ssoMode || flow.showEmailInput ? (
                // Email input view (shown after clicking "Continue with Email" or in emailOnly/SSO mode)
                <>
                  <EmailInputForm
                    email={flow.email}
                    emailValidation={flow.emailValidation}
                    onSubmit={handleEmailSubmit}
                    onEmailChange={flow.handleEmailChange}
                    placeholder="you@example.com"
                    autoFocus={true}
                    isLoading={flow.showTurnstile || flow.isVerifying}
                    submitLabel={
                      !isSignUp && !emailOnly && !ssoMode ? 'Continue with Email' : undefined
                    }
                  />

                  {ssoMode ? (
                    // In SSO mode, show a link back to the main sign-in page
                    <Link
                      href={buildNormalSignInHref(searchParams)}
                      className="text-muted-foreground mt-6 inline-block text-sm hover:underline"
                    >
                      ← Back to sign in options
                    </Link>
                  ) : !emailOnly && isSignUp ? (
                    // In regular email input mode (not emailOnly), show back button
                    <button
                      onClick={flow.handleBack}
                      className="text-muted-foreground mt-6 text-sm hover:underline"
                    >
                      ← Back to sign in options
                    </button>
                  ) : null}
                  {!isSignUp && !emailOnly && !ssoMode && (
                    <>
                      {/* The sign-in page keeps the email prompt first, but the
                          OAuth providers (including 'Sign in with ChatGPT') are
                          offered beside it, as they are on sign-up. */}
                      <div className="my-6 flex items-center gap-3">
                        <Separator className="flex-1" />
                        <span className="text-muted-foreground text-xs font-medium">or</span>
                        <Separator className="flex-1" />
                      </div>
                      <div className="space-y-2">
                        <AuthProviderButtons
                          providers={withoutChatGptWhenUnavailable(
                            OAuthProviderIds,
                            chatGptAllowed
                          )}
                          onProviderClick={flow.handleOAuthClick}
                        />
                      </div>
                      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
                        By continuing, you are agreeing to the{' '}
                        <a
                          href="https://kilo.ai/terms"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-foreground underline underline-offset-4 transition-colors"
                        >
                          Terms &amp; Conditions
                        </a>
                      </p>
                    </>
                  )}
                </>
              ) : (
                // Provider buttons view (initial state)
                <>
                  <div className="space-y-2">
                    {/* Passkey sign-in sits above the OAuth providers; none of them move */}
                    <PasskeySignInButton callbackUrl={passkeyCallbackUrl} />
                    {/* OAuth provider buttons - Google first */}
                    <AuthProviderButtons
                      providers={withoutChatGptWhenUnavailable(OAuthProviderIds, chatGptAllowed)}
                      onProviderClick={flow.handleOAuthClick}
                    />
                    <SignInButton onClick={flow.handleShowEmailInput}>
                      Continue with Email
                    </SignInButton>
                  </div>

                  <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
                    By continuing, you are agreeing to the{' '}
                    <a
                      href="https://kilo.ai/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-foreground underline underline-offset-4 transition-colors"
                    >
                      Terms &amp; Conditions
                    </a>
                  </p>
                </>
              )}
            </>
          )}

          {/* Keep Enterprise SSO available for normal sign-in; the install link belongs to one footer only. */}
          {!emailOnly && !ssoMode && flow.tier === 'new' && !isSignUp && (
            <div className="border-border mt-8 flex flex-col items-center gap-3 border-t pt-6">
              <Link
                href={buildEnterpriseSsoHref(searchParams)}
                className="w-full flex h-10 items-center justify-center rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0"
              >
                <SquareUserRound className="size-4" />
                Enterprise SSO
              </Link>
              {!flow.showEmailInput && (
                <Link
                  href="/get-started"
                  className="mt-4 text-center text-brand-primary text-sm font-medium underline-offset-4 hover:underline"
                >
                  Install Kilo Code
                </Link>
              )}
            </div>
          )}

          {/* Sign-up mode footer - keep original treatment for now */}
          {!emailOnly && !ssoMode && isSignUp && (
            <>
              <div className="mx-auto mt-8 max-w-md">
                <p className="text-muted-foreground text-sm">
                  Already have an account?{' '}
                  <Link
                    href={buildNormalSignInHref(searchParams)}
                    className="text-brand-primary font-medium underline-offset-4 hover:underline"
                  >
                    Sign in
                  </Link>
                </p>
              </div>
              <p className="text-muted-foreground mt-8 mb-12 text-sm">
                We&rsquo;ll email on occasion. Unsubscribe with one click.
              </p>
            </>
          )}

          {/* Other tiers (returning, invite, email-input, etc.) keep original "Get started" / "Sign in" link */}
          {!emailOnly && !ssoMode && !isSignUp && (flow.tier !== 'new' || flow.showEmailInput) && (
            <div className="mx-auto mt-8 max-w-md">
              <p className="text-muted-foreground text-sm">
                <Link
                  href="/get-started"
                  className="text-brand-primary font-medium underline-offset-4 hover:underline"
                >
                  Install Kilo Code
                </Link>
              </p>
            </div>
          )}
        </div>
        {/* End min-height content area */}
      </div>
    </>
  );
}
