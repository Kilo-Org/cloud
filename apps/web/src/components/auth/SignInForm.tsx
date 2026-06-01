'use client';

import { MagicLinkSentConfirmation } from '@/components/auth/MagicLinkSentConfirmation';
import { useSignInFlow } from '@/hooks/useSignInFlow';
import { TurnstileView } from '@/components/auth/sign-in/TurnstileView';
import { ProviderSelectView } from '@/components/auth/sign-in/ProviderSelectView';
import { EmailInputForm } from '@/components/auth/sign-in/EmailInputForm';
import { AuthProviderButtons } from '@/components/auth/sign-in/AuthProviderButtons';
import { SignInButton } from '@/components/auth/SigninButton';
import { FakeLoginForm } from '@/components/auth/FakeLoginForm';
import { AuthErrorNotification } from '@/components/auth/AuthErrorNotification';
import { AnimatedLogoMark } from '@/components/AnimatedLogoMark';
import Link from 'next/link';
import { Mail, SquareUserRound } from 'lucide-react';
import type { SignInFormInitialState } from '@/hooks/useSignInFlow';
import { OAuthProviderIds } from '@/lib/auth/provider-metadata';

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

function signInHrefFromSearchParams(searchParams: Record<string, string>): string {
  const params = new URLSearchParams(searchParams);
  params.delete('signup');
  const query = params.toString();
  return query ? `/users/sign_in?${query}` : '/users/sign_in';
}

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

  // Show error notification at the top level for all states that can display errors
  const errorNotification = flow.error ? <AuthErrorNotification error={flow.error} /> : null;

  // Turnstile overlay
  if (flow.showTurnstile) {
    return (
      <TurnstileView
        email={flow.email}
        pendingSignIn={flow.pendingSignIn}
        turnstileError={flow.turnstileError}
        isVerifying={flow.isVerifying}
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
          providers={flow.availableProviders}
          onProviderSelect={flow.handleProviderSelect}
          onBack={flow.handleBack}
        />
      </div>
    );
  }

  // Landing state - render based on tier
  // ────────────────────────────────────

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
                  // SSO user - only show SSO button, no "other methods" option
                  const orgId = hint.orgId;
                  return (
                    <div className="mx-auto max-w-md space-y-4">
                      <SignInButton onClick={() => flow.handleSSOContinue(orgId)}>
                        Sign in with Enterprise SSO
                      </SignInButton>
                    </div>
                  );
                }

                // Non-SSO user - show preferred provider with optional "other methods"
                // If email provider and we have their email, show "Email me a magic link" instead
                const emailCustomLabel =
                  lastAuthMethod === 'email' && hint.lastEmail
                    ? { email: 'Email me a magic link' }
                    : undefined;

                return (
                  <div className="mx-auto max-w-md space-y-4">
                    {/* Preferred provider button only */}
                    <AuthProviderButtons
                      providers={[lastAuthMethod]}
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
                error={flow.error}
                onSubmit={flow.handleEmailSubmit}
                onEmailChange={flow.handleEmailChange}
                placeholder="you@example.com"
                autoFocus={true}
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
              {emailOnly || ssoMode || flow.showEmailInput ? (
                // Email input view (shown after clicking "Continue with Email" or in emailOnly/SSO mode)
                <>
                  <EmailInputForm
                    email={flow.email}
                    emailValidation={flow.emailValidation}
                    error={flow.error}
                    onSubmit={flow.handleEmailSubmit}
                    onEmailChange={flow.handleEmailChange}
                    placeholder="you@example.com"
                    autoFocus={true}
                  />

                  {ssoMode ? (
                    // In SSO mode, show a link back to the main sign-in page
                    <Link
                      href="/users/sign_in"
                      className="text-muted-foreground mt-6 inline-block text-sm hover:underline"
                    >
                      ← Back to sign in options
                    </Link>
                  ) : !emailOnly ? (
                    // In regular email input mode (not emailOnly), show back button
                    <button
                      onClick={flow.handleBack}
                      className="text-muted-foreground mt-6 text-sm hover:underline"
                    >
                      ← Back to sign in options
                    </button>
                  ) : null}
                </>
              ) : (
                // Provider buttons view (initial state)
                <>
                  <div className="space-y-2">
                    {/* OAuth provider buttons - Google first */}
                    <AuthProviderButtons
                      providers={OAuthProviderIds}
                      onProviderClick={flow.handleOAuthClick}
                    />
                    <SignInButton onClick={flow.handleShowEmailInput}>
                      <Mail />
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

          {/* Secondary actions footer - hidden in emailOnly or SSO mode and only on the new-user landing screen */}
          {!emailOnly && !ssoMode && flow.tier === 'new' && !flow.showEmailInput && !isSignUp && (
            <div className="border-border mt-8 flex flex-col items-center gap-3 border-t pt-6">
              <Link
                href="/users/sign_in?sso=true"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm transition-colors"
              >
                <SquareUserRound className="size-4" />
                Enterprise SSO
              </Link>
              <Link
                href="/get-started"
                className="text-brand-primary text-sm font-medium underline-offset-4 hover:underline"
              >
                Get started with Kilo Code
              </Link>
            </div>
          )}

          {/* Sign-up mode footer - keep original treatment for now */}
          {!emailOnly && !ssoMode && isSignUp && (
            <>
              <div className="mx-auto mt-8 max-w-md">
                <p className="text-muted-foreground text-sm">
                  Already have an account?{' '}
                  <Link
                    href={signInHrefFromSearchParams(searchParams)}
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
                  Get started with Kilo Code
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
