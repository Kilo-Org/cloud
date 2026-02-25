'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { signIn } from 'next-auth/react';
import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';
import { captureException } from '@sentry/nextjs';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import { ProdNonSSOAuthProviders } from '@/lib/auth/provider-metadata';
import { useSignInHint, type SignInHint } from '@/hooks/useSignInHint';
import { emailSchema, validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { sendMagicLink } from '@/lib/auth/send-magic-link';
import type { SSOOrganizationsResponse } from '@/lib/schemas/sso-organizations';

export type FlowState = 'landing' | 'provider-select' | 'magic-link-sent' | 'redirecting';
export type Tier = 'returning' | 'new' | 'invite';

/**
 * Only used for Storybook to mock out component state.
 */
export type SignInFormInitialState = {
  flowState?: FlowState;
  tier?: Tier;
  email?: string;
  showTurnstile?: boolean;
  showEmailInput?: boolean;
  showOtherMethods?: boolean;
  pendingSignIn?: AuthProviderId | null;
  turnstileError?: boolean;
  availableProviders?: AuthProviderId[];
  isNewUser?: boolean;
  hint?: SignInHint | null; // Mock hint for Storybook returning user stories
};

export type SignInFlowProps = {
  searchParams: Record<string, string>;
  error?: string;
  ssoMode?: boolean; // If true, automatically show email input for SSO flow
  isSignUp?: boolean; // If true, never show "returning user" tier - always show all providers
  storybookInitialState?: SignInFormInitialState;
};

export type SignInFlowReturn = {
  // Flow state
  flowState: FlowState;
  tier: Tier;
  showTurnstile: boolean;
  isVerifying: boolean;
  showEmailInput: boolean;
  showOtherMethods: boolean;
  isHintLoaded: boolean;

  // Data
  email: string;
  emailValidation: { isValid: boolean; error: string | null };
  hint: SignInHint | null;
  availableProviders: AuthProviderId[];
  isNewUser: boolean;
  inviteOrgId?: string;
  inviteOrgName?: string;
  error: string;
  pendingSignIn: AuthProviderId | null;
  turnstileError: boolean;

  // Handlers
  handleEmailChange: (value: string) => void;
  handleEmailSubmit: (e: React.FormEvent) => void;
  handleOAuthClick: (provider: AuthProviderId) => void;
  handleSSOContinue: (orgId: string) => void;
  handleClearHint: () => void;
  handleClearInvite: () => void;
  handleProviderSelect: (provider: AuthProviderId) => Promise<void>;
  handleBack: () => void;
  handleTurnstileSuccess: (token: string) => void;
  handleTurnstileError: () => void;
  handleRetryTurnstile: () => void;
  handleSendMagicLink: () => Promise<void>;
  handleShowEmailInput: () => void;
  handleToggleOtherMethods: () => void;
};

export function useSignInFlow({
  searchParams,
  error: initialError,
  ssoMode = false,
  isSignUp = false,
  storybookInitialState,
}: SignInFlowProps): SignInFlowReturn {
  const params = searchParams;
  const realHint = useSignInHint();
  // Use storybook hint if provided, otherwise use real hint from localStorage
  const hint =
    storybookInitialState?.hint !== undefined ? storybookInitialState.hint : realHint.hint;
  const clearHint = realHint.clearHint;
  const saveHint = realHint.saveHint;
  // For storybook, consider hints always loaded; otherwise use the real loading state
  const isHintLoaded = storybookInitialState ? true : realHint.isLoaded;

  // Determine tier based on hint and params
  const tier = useMemo<Tier>(() => {
    if (storybookInitialState?.tier) {
      return storybookInitialState.tier;
    }
    // On sign-up pages, never show returning user tier - always show all providers
    if (isSignUp) {
      // Tier 3: Invite params take precedence even on sign-up
      if (params.email && params.org) {
        return 'invite';
      }
      // Always show new user flow on sign-up
      return 'new';
    }
    // Tier 3: Invite params take precedence
    if (params.email && params.org) {
      return 'invite';
    }
    // Tier 1: Returning user with hint
    if (hint?.lastAuthMethod) {
      return 'returning';
    }
    // Tier 2: New/unknown user (default)
    return 'new';
  }, [params, hint, storybookInitialState, isSignUp]);

  // Flow state - always starts at landing unless Storybook override
  const [flowState, setFlowState] = useState<FlowState>(
    storybookInitialState?.flowState ?? 'landing'
  );

  // Email state - initialize from params if available (e.g., SSO redirect with email)
  const [emailState, setEmailState] = useState(
    storybookInitialState?.email ?? (params.email || '')
  );
  const email = storybookInitialState?.email ?? emailState;

  // Initialize email from hint or params
  useEffect(() => {
    if (storybookInitialState) return;

    if (tier === 'returning' && hint?.lastEmail && emailState !== hint.lastEmail) {
      setEmailState(hint.lastEmail);
    } else if (tier === 'invite' && params.email && emailState !== params.email) {
      setEmailState(params.email);
    } else if (params.email && !emailState) {
      // Prefill from query params (e.g., redirect with error)
      setEmailState(params.email);
    }
  }, [tier, hint?.lastEmail, params.email, storybookInitialState]);

  const [error, setError] = useState(initialError || '');
  const [showTurnstile, setShowTurnstile] = useState(storybookInitialState?.showTurnstile ?? false);
  const [pendingSignIn, setPendingSignIn] = useState<AuthProviderId | null>(
    storybookInitialState?.pendingSignIn ?? null
  );
  const [isVerifying, setIsVerifying] = useState(false);
  const [turnstileError, setTurnstileError] = useState(
    storybookInitialState?.turnstileError ?? false
  );
  const [availableProviders, setAvailableProviders] = useState<AuthProviderId[]>(
    storybookInitialState?.availableProviders ?? []
  );
  const [isNewUser, setIsNewUser] = useState(storybookInitialState?.isNewUser ?? false);

  // UI state for new user flow (show email input when "Continue with Email" is clicked or in SSO mode)
  // Auto-show email input if DIFFERENT-OAUTH error - user needs to re-enter email
  const [showEmailInput, setShowEmailInput] = useState(
    storybookInitialState?.showEmailInput ?? (ssoMode || initialError === 'DIFFERENT-OAUTH')
  );

  // UI state for returning user flow (expand to show other sign-in methods)
  const [showOtherMethods, setShowOtherMethods] = useState(
    storybookInitialState?.showOtherMethods ?? false
  );

  // Store pending SSO orgId in ref instead of window object
  const pendingSSOOrgIdRef = useRef<string | null>(null);

  // Extract invite info from params
  const inviteOrgId = useMemo(() => {
    if (tier === 'invite' && params.org) {
      return params.org;
    }
    return undefined;
  }, [tier, params.org]);

  const inviteOrgName = useMemo(() => {
    // Could be enhanced to fetch org name, but for now just use org ID
    return inviteOrgId;
  }, [inviteOrgId]);

  const emailValidation = useMemo(() => {
    if (!email.trim()) {
      return { isValid: false, error: null };
    }
    const result = emailSchema.safeParse({ email });
    if (!result.success) {
      return {
        isValid: false,
        error: result.error.issues[0]?.message || 'Invalid email',
      };
    }
    // For signup pages with magic link selected, validate email restrictions
    // Only show this on explicit signup pages (isSignUp=true) when user has selected email provider
    // Don't show on sign-in pages to avoid confusing existing users
    if (isSignUp && pendingSignIn === 'email') {
      const magicLinkValidation = validateMagicLinkSignupEmail(email);
      if (!magicLinkValidation.valid) {
        return { isValid: false, error: magicLinkValidation.error };
      }
    }
    return { isValid: true, error: null };
  }, [email, isSignUp, pendingSignIn]);

  // Auto-trigger Turnstile when email is prefilled from query params
  // Note: This shows Turnstile but doesn't automatically perform lookup.
  // The lookup happens after user completes Turnstile verification in handleTurnstileSuccess.
  useEffect(() => {
    if (params.email && !storybookInitialState && !initialError) {
      const prefilledEmail = params.email;
      if (emailSchema.safeParse({ email: prefilledEmail }).success) {
        setShowTurnstile(true);
        setTurnstileError(false);
      }
    }
  }, [params.email, storybookInitialState, initialError]);

  const handleEmailChange = useCallback(
    (value: string) => {
      setEmailState(value);
      setError('');
      // Reset provider state when email changes
      if (value !== email) {
        setAvailableProviders([]);
      }
    },
    [email]
  );

  const lookupEmailProviderAndContinue = useCallback(async () => {
    if (!email.trim()) {
      return;
    }

    try {
      const checkResponse = await fetch('/api/sso/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const checkResult = (await checkResponse.json()) as SSOOrganizationsResponse;
      if (!checkResponse.ok) {
        console.error('[SignInForm] Domain check failed:', checkResult);
        setIsVerifying(false);
        setShowTurnstile(false);
        setError('An error occurred. Please try again.');
        setFlowState('landing');
        return;
      }

      // SSO domain - redirect to WorkOS (only SSO option)
      if (checkResult.organizationId) {
        // Save hint before redirecting so returning user experience works
        saveHint({
          lastEmail: email,
          lastAuthMethod: 'workos',
          orgId: checkResult.organizationId,
          lastLogin: new Date().toISOString(),
        });

        setIsVerifying(false);
        setShowTurnstile(false);
        setFlowState('redirecting');
        const callbackUrl = getSignInCallbackUrl(params);
        await signIn('workos', { callbackUrl }, { organization: checkResult.organizationId });
        return;
      }

      // Save hint before showing provider selection
      if (checkResult.providers.length > 0) {
        saveHint({
          lastEmail: email,
          lastAuthMethod: checkResult.providers[0] as AuthProviderId,
          lastLogin: new Date().toISOString(),
        });
      }

      // Determine available providers based on user status
      const isNewUser = checkResult.newUser;
      setIsNewUser(isNewUser);

      let providersToShow: AuthProviderId[];
      if (isNewUser) {
        // New user: show all available providers (they can choose any to create account)
        providersToShow = [...ProdNonSSOAuthProviders];
        // For new users (signup), filter out magic link if email is invalid
        const magicLinkValidation = validateMagicLinkSignupEmail(email);
        if (!magicLinkValidation.valid) {
          providersToShow = providersToShow.filter(p => p !== 'email');
        }
      } else {
        // Existing user: only show providers they actually have linked
        // This prevents "OAuth different" errors from picking wrong provider
        providersToShow = checkResult.providers.filter((p): p is AuthProviderId =>
          ProdNonSSOAuthProviders.includes(p as AuthProviderId)
        );
        // If for some reason no valid providers found, fall back to showing all
        if (providersToShow.length === 0) {
          providersToShow = [...ProdNonSSOAuthProviders];
        }
      }

      setIsVerifying(false);
      setAvailableProviders(providersToShow);
      setFlowState('provider-select');
      setShowTurnstile(false);
    } catch (error) {
      console.error('[SignInForm] Error during email check:', error);
      captureException(error, {
        tags: { source: 'email_lookup' },
      });
      setIsVerifying(false);
      setShowTurnstile(false);
      setError('An error occurred. Please try again.');
      setFlowState('landing');
    }
  }, [email, params, saveHint]);

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      const result = emailSchema.safeParse({ email });
      if (!result.success) {
        setError(result.error.issues[0]?.message || 'Invalid email');
        return;
      }

      // Show Turnstile for verification
      setShowTurnstile(true);
      setTurnstileError(false);
    },
    [email]
  );

  const handleOAuthClick = useCallback(
    async (provider: AuthProviderId) => {
      setPendingSignIn(provider);

      // If clicking email provider but we don't have their email, show email input instead of Turnstile
      if (provider === 'email' && !email.trim()) {
        setShowEmailInput(true);
        return;
      }

      // For magic link on signup pages, validate email before proceeding
      if (provider === 'email' && isSignUp) {
        const validation = validateMagicLinkSignupEmail(email);
        if (!validation.valid) {
          setError(validation.error ?? 'Invalid email for signup');
          return;
        }
      }

      setTurnstileError(false);
      setShowTurnstile(true);
    },
    [email, isSignUp]
  );

  const handleSSOContinue = useCallback(async (orgId: string) => {
    setTurnstileError(false);
    setShowTurnstile(true);
    setPendingSignIn('workos');
    // Store orgId temporarily for turnstile success handler
    pendingSSOOrgIdRef.current = orgId;
  }, []);

  const handleSendMagicLink = useCallback(async () => {
    if (!email.trim()) {
      console.error('[SignIn] handleSendMagicLink called without email');
      return;
    }

    try {
      const result = await sendMagicLink(email);
      if (result.success) {
        saveHint({
          lastEmail: email,
          lastAuthMethod: 'email',
          lastLogin: new Date().toISOString(),
        });
        setFlowState('magic-link-sent');
      } else {
        setError(result.error);
      }
    } catch (error) {
      console.error('[SignInForm] Magic link request failed:', error);
      captureException(error, {
        tags: { source: 'magic_link_request' },
      });
      setError('Failed to send magic link. Please try again.');
    }
  }, [email, saveHint]);

  const handleTurnstileSuccess = useCallback(
    async (token: string) => {
      setIsVerifying(true);
      setTurnstileError(false);

      try {
        const verifyResponse = await fetch('/api/auth/verify-turnstile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const verifyResult = await verifyResponse.json();
        if (!verifyResponse.ok || !verifyResult.success) {
          console.error('[SignInForm] Turnstile verification failed:', verifyResult.error);
          setIsVerifying(false);
          setTurnstileError(true);
          return;
        }

        // Handle SSO redirect (from returning user or invite)
        const pendingSSOOrgId = pendingSSOOrgIdRef.current;
        if (pendingSSOOrgId) {
          pendingSSOOrgIdRef.current = null; // Clear after use
          // Save hint before redirecting so returning user experience works
          if (email) {
            saveHint({
              lastEmail: email,
              lastAuthMethod: 'workos',
              orgId: pendingSSOOrgId,
              lastLogin: new Date().toISOString(),
            });
          }
          setIsVerifying(false);
          setShowTurnstile(false);
          setFlowState('redirecting');
          const callbackUrl = getSignInCallbackUrl(params);
          await signIn('workos', { callbackUrl }, { organization: pendingSSOOrgId });
          return;
        }

        // Handle returning user clicking "Continue with Email" when we already have their email
        // Skip the lookup and directly send magic link
        if (pendingSignIn === 'email' && email.trim()) {
          setIsVerifying(false);
          setShowTurnstile(false);
          await handleSendMagicLink();
          return;
        }

        // Handle direct OAuth - user explicitly clicked a provider button
        // This takes precedence over email lookup to honor user's explicit choice
        if (pendingSignIn) {
          // Save hint with email if available for better returning user experience
          saveHint({
            lastEmail: email || undefined,
            lastAuthMethod: pendingSignIn,
            lastLogin: new Date().toISOString(),
          });
          setIsVerifying(false);
          setShowTurnstile(false);
          setFlowState('redirecting');
          const callbackUrl = getSignInCallbackUrl(params);
          await signIn(pendingSignIn, { callbackUrl });
          return;
        }

        // Handle email lookup - only when no explicit provider was selected
        if (email.trim()) {
          await lookupEmailProviderAndContinue();
          return;
        }

        // Edge case: Turnstile succeeded but no email or pendingSignIn
        // This shouldn't happen in normal flow, but handle gracefully
        console.warn('[SignInForm] Turnstile succeeded but no email or pendingSignIn');
        setIsVerifying(false);
        setShowTurnstile(false);
        setFlowState('landing');
      } catch (error) {
        console.error('[SignInForm] Error during sign-in flow:', error);
        captureException(error, {
          tags: { source: 'turnstile_verification' },
        });
        setError('An error occurred. Please try again.');
        setShowTurnstile(false);
        setFlowState('landing');
        setIsVerifying(false);
      }
    },
    [email, params, pendingSignIn, lookupEmailProviderAndContinue, saveHint, handleSendMagicLink]
  );

  const handleTurnstileError = useCallback(() => {
    setIsVerifying(false);
    setTurnstileError(true);
  }, []);

  const handleRetryTurnstile = useCallback(() => {
    setTurnstileError(false);
    setShowTurnstile(false);
    setTimeout(() => {
      setShowTurnstile(true);
    }, 100);
  }, []);

  const handleProviderSelect = useCallback(
    async (provider: AuthProviderId) => {
      // If no email was entered, show Turnstile first
      if (email.trim() === '') {
        setPendingSignIn(provider);
        setShowTurnstile(true);
        setTurnstileError(false);
        return;
      }

      // Email was entered and verified, proceed with OAuth
      if (provider === 'email') {
        // For magic link on signup pages, validate email before sending
        if (isSignUp) {
          const validation = validateMagicLinkSignupEmail(email);
          if (!validation.valid) {
            setError(validation.error ?? 'Invalid email for signup');
            return;
          }
        }
        // Handle magic link
        await handleSendMagicLink();
        return;
      }

      try {
        // Save hint before redirecting so returning user experience works
        saveHint({
          lastEmail: email,
          lastAuthMethod: provider,
          lastLogin: new Date().toISOString(),
        });
        setFlowState('redirecting');
        const callbackUrl = getSignInCallbackUrl(params);
        await signIn(provider, { callbackUrl });
      } catch (error) {
        console.error('[SignInForm] OAuth sign-in failed:', error);
        captureException(error, {
          tags: { source: 'oauth_signin' },
        });
        setError('Failed to sign in. Please try again.');
        setFlowState('provider-select');
      }
    },
    [params, email, handleSendMagicLink, saveHint]
  );

  const handleBack = useCallback(() => {
    setFlowState('landing');
    setShowTurnstile(false);
    setPendingSignIn(null);
    setTurnstileError(false);
    setError('');
    setAvailableProviders([]);
    setShowEmailInput(false);
    setShowOtherMethods(false);
  }, []);

  const handleShowEmailInput = useCallback(() => {
    setShowEmailInput(true);
    setPendingSignIn('email');
  }, []);

  const handleToggleOtherMethods = useCallback(() => {
    setShowOtherMethods(prev => !prev);
  }, []);

  const handleClearHint = useCallback(() => {
    clearHint();
    setEmailState('');
    setFlowState('landing');
    setShowEmailInput(false);
    setShowOtherMethods(false);
  }, [clearHint]);

  const handleClearInvite = useCallback(() => {
    // Clear invite params by navigating without them
    const newParams = new URLSearchParams(params);
    newParams.delete('email');
    newParams.delete('org');
    window.history.replaceState({}, '', `${window.location.pathname}?${newParams.toString()}`);
    setEmailState('');
    setFlowState('landing');
    setShowEmailInput(false);
    setShowOtherMethods(false);
  }, [params]);

  return {
    flowState,
    tier,
    showTurnstile,
    isVerifying,
    showEmailInput,
    showOtherMethods,
    isHintLoaded,
    email,
    emailValidation,
    hint,
    availableProviders,
    isNewUser,
    inviteOrgId,
    inviteOrgName,
    error,
    pendingSignIn,
    turnstileError,
    handleEmailChange,
    handleEmailSubmit,
    handleOAuthClick,
    handleSSOContinue,
    handleClearHint,
    handleClearInvite,
    handleProviderSelect,
    handleBack,
    handleTurnstileSuccess,
    handleTurnstileError,
    handleRetryTurnstile,
    handleSendMagicLink,
    handleShowEmailInput,
    handleToggleOtherMethods,
  };
}
