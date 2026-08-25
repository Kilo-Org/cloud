'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { signIn } from 'next-auth/react';
import getSignInCallbackUrl from '@/lib/getSignInCallbackUrl';
import type { AuthProviderId } from '@/lib/auth/provider-metadata';
import { useSignInHint, type SignInHint } from '@/hooks/useSignInHint';
import { emailSchema, validateMagicLinkSignupEmail } from '@/lib/schemas/email';
import { sendMagicLink } from '@/lib/auth/send-magic-link';
import { shouldDiscardSsoHintOnError } from '@/lib/auth/sign-in-hint-recovery';
import { SignInDiscoveryResponseSchema } from '@/lib/schemas/sso-organizations';
import { orderNewAccountProviders, resolveSignInMethods } from '@/lib/auth/sign-in-methods';

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
  isDeliveringMagicLink: boolean;
  showEmailInput: boolean;
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
  turnstileAttemptId: number;

  // Handlers
  handleEmailChange: (value: string) => void;
  handleEmailSubmit: (e: React.FormEvent) => void;
  handleOAuthClick: (provider: AuthProviderId) => void;
  handleSSOContinue: (orgId: string) => void;
  handleClearHint: () => void;
  handleClearInvite: () => void;
  handleProviderSelect: (provider: AuthProviderId) => Promise<boolean>;
  handleBack: () => void;
  handleTurnstileSuccess: (token: string, attemptId?: number) => void;
  handleTurnstileError: (attemptId: number) => void;
  handleRetryTurnstile: () => void;
  handleSendMagicLink: () => Promise<void>;
  handleShowEmailInput: () => void;
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
  const [isInviteCleared, setIsInviteCleared] = useState(false);

  // Determine tier based on hint and params
  const tier = useMemo<Tier>(() => {
    if (storybookInitialState?.tier) {
      return storybookInitialState.tier;
    }
    // On sign-up pages, never show returning user tier - always show all providers
    if (isSignUp) {
      // Tier 3: Invite params take precedence even on sign-up
      if (!isInviteCleared && params.email && params.org) {
        return 'invite';
      }
      // Always show new user flow on sign-up
      return 'new';
    }
    // Tier 3: Invite params take precedence
    if (!isInviteCleared && params.email && params.org) {
      return 'invite';
    }
    // Tier 1: Returning user with hint
    if (hint?.lastAuthMethod) {
      return 'returning';
    }
    // Tier 2: New/unknown user (default)
    return 'new';
  }, [params, hint, storybookInitialState, isInviteCleared, isSignUp]);

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
    if (isInviteCleared) return;

    if (tier === 'returning' && hint?.lastEmail && emailState !== hint.lastEmail) {
      setEmailState(hint.lastEmail);
    } else if (tier === 'invite' && params.email && emailState !== params.email) {
      setEmailState(params.email);
    } else if (params.email && !emailState) {
      // Prefill from query params (e.g., redirect with error)
      setEmailState(params.email);
    }
  }, [tier, hint?.lastEmail, params.email, storybookInitialState, isInviteCleared]);

  const [error, setError] = useState(initialError || '');
  const [showTurnstile, setShowTurnstile] = useState(storybookInitialState?.showTurnstile ?? false);
  const [pendingSignIn, setPendingSignIn] = useState<AuthProviderId | null>(
    storybookInitialState?.pendingSignIn ?? null
  );
  const [isVerifying, setIsVerifying] = useState(false);
  const [isDeliveringMagicLink, setIsDeliveringMagicLink] = useState(false);
  const [turnstileError, setTurnstileError] = useState(
    storybookInitialState?.turnstileError ?? false
  );
  const [turnstileAttemptId, setTurnstileAttemptId] = useState(0);
  const [availableProviders, setAvailableProviders] = useState<AuthProviderId[]>(
    storybookInitialState?.availableProviders ?? []
  );
  const [isNewUser, setIsNewUser] = useState(storybookInitialState?.isNewUser ?? false);

  // UI state for new user flow (show email input when "Continue with Email" is clicked or in SSO mode)
  // Auto-show email input if DIFFERENT-OAUTH error - user needs to re-enter email
  const [showEmailInput, setShowEmailInput] = useState(
    storybookInitialState?.showEmailInput ??
      (!isSignUp || ssoMode || initialError === 'DIFFERENT-OAUTH')
  );

  // Recover from a stale SSO hint. A hint pointing at a WorkOS organization that
  // no longer resolves renders an "Enterprise SSO" button that can only ever fail,
  // and that screen has no alternative method, so retries loop forever. Dropping
  // the hint falls back to the email prompt, which re-runs the server-side
  // organization lookup. See shouldDiscardSsoHintOnError for the full reasoning.
  //
  // One-shot: only the hint the user arrived with is inspected, so a hint saved
  // later in this session (just before signIn redirects) is never clobbered.
  const hintRecoveryCheckedRef = useRef(false);
  useEffect(() => {
    if (storybookInitialState || !isHintLoaded || hintRecoveryCheckedRef.current) {
      return;
    }
    hintRecoveryCheckedRef.current = true;

    if (!shouldDiscardSsoHintOnError(hint, initialError)) {
      return;
    }

    const rememberedEmail = hint?.lastEmail;
    clearHint();
    // Keep the address so recovery is a single click instead of a retype.
    if (rememberedEmail) {
      setEmailState(rememberedEmail);
    }
    setShowEmailInput(true);
  }, [isHintLoaded, hint, initialError, clearHint, storybookInitialState]);

  // Store pending SSO orgId in ref instead of window object
  const pendingSSOOrgIdRef = useRef<string | null>(null);
  const clearPendingSso = useCallback(() => {
    pendingSSOOrgIdRef.current = null;
  }, []);
  // A Turnstile verification can outlive the UI that initiated it. Keep the
  // generation in this hook so a late discovery response cannot resume an
  // abandoned email flow or redirect the browser for a stale address.
  const discoveryRequestRef = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const activeTurnstileAttemptRef = useRef<number | null>(0);
  const nextTurnstileAttemptRef = useRef(0);
  // Turnstile can invoke onSuccess more than once before React commits the
  // loading view. Keep this synchronous guard through discovery and magic-link
  // delivery so a second callback cannot start another request.
  const isTurnstileSubmissionPendingRef = useRef(false);

  const invalidateDiscoveryRequest = useCallback(() => {
    discoveryRequestRef.current.generation += 1;
    discoveryRequestRef.current.controller?.abort();
    discoveryRequestRef.current.controller = null;
  }, []);

  const retireTurnstileWidget = useCallback(() => {
    invalidateDiscoveryRequest();
    activeTurnstileAttemptRef.current = null;
    setIsDeliveringMagicLink(false);
  }, [invalidateDiscoveryRequest]);

  const createTurnstileWidgetAttempt = useCallback(() => {
    invalidateDiscoveryRequest();
    nextTurnstileAttemptRef.current += 1;
    activeTurnstileAttemptRef.current = nextTurnstileAttemptRef.current;
    setTurnstileAttemptId(nextTurnstileAttemptRef.current);
  }, [invalidateDiscoveryRequest]);

  const beginDiscoveryRequest = useCallback(() => {
    invalidateDiscoveryRequest();
    return discoveryRequestRef.current.generation;
  }, [invalidateDiscoveryRequest]);

  const isCurrentDiscoveryRequest = useCallback(
    (generation: number) => discoveryRequestRef.current.generation === generation,
    []
  );

  const deliverMagicLink = useCallback(
    async (generation: number): Promise<boolean> => {
      if (!email.trim() || !isCurrentDiscoveryRequest(generation)) {
        return false;
      }

      setIsDeliveringMagicLink(true);
      const callbackUrl = getSignInCallbackUrl(params);
      try {
        const result = await sendMagicLink(email, callbackUrl);
        if (!isCurrentDiscoveryRequest(generation)) return false;

        if (result.success) {
          saveHint({
            lastEmail: email,
            lastAuthMethod: 'email',
            lastLogin: new Date().toISOString(),
          });
          setIsVerifying(false);
          setShowTurnstile(false);
          setFlowState('magic-link-sent');
          return false;
        }
        if (result.ssoOrganizationId) {
          saveHint({
            lastEmail: email,
            lastAuthMethod: 'workos',
            orgId: result.ssoOrganizationId,
            lastLogin: new Date().toISOString(),
          });
          setIsVerifying(false);
          setShowTurnstile(false);
          setFlowState('redirecting');
          await signIn('workos', { callbackUrl }, { organization: result.ssoOrganizationId });
          return true;
        }
        setIsVerifying(false);
        setShowTurnstile(false);
        setError(result.error);
        setFlowState('landing');
        return false;
      } catch (error) {
        if (!isCurrentDiscoveryRequest(generation)) return false;
        console.error('[SignInForm] Magic link request failed:', error);
        setIsVerifying(false);
        setShowTurnstile(false);
        setError('Failed to send magic link. Please try again.');
        setFlowState('landing');
        return false;
      } finally {
        if (isCurrentDiscoveryRequest(generation)) {
          setIsDeliveringMagicLink(false);
        }
      }
    },
    [email, isCurrentDiscoveryRequest, params, saveHint]
  );

  useEffect(
    () => () => {
      clearPendingSso();
      retireTurnstileWidget();
    },
    [clearPendingSso, retireTurnstileWidget]
  );

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

  // Query-email verification is a one-shot action for each distinct address in
  // this mounted flow. In particular, returning from provider selection must
  // leave the prefilled address editable rather than reopening Turnstile.
  const autoVerifiedQueryEmailsRef = useRef(new Set<string>());

  // Auto-trigger Turnstile when email is prefilled from query params.
  // Note: This shows Turnstile but doesn't automatically perform lookup.
  // The lookup happens after user completes Turnstile verification in handleTurnstileSuccess.
  useEffect(() => {
    // Query-email verification belongs to normal email-first sign-in only.
    // Explicit sign-up is provider-first, and invite URLs own their SSO CTA.
    // DIFFERENT-OAUTH recovery still pre-fills and displays the normal email
    // form through showEmailInput; it must not silently resume discovery.
    const prefilledEmail = params.email;
    if (
      prefilledEmail &&
      !storybookInitialState &&
      !initialError &&
      !isSignUp &&
      !isInviteCleared &&
      flowState === 'landing' &&
      tier !== 'invite' &&
      !autoVerifiedQueryEmailsRef.current.has(prefilledEmail)
    ) {
      if (emailSchema.safeParse({ email: prefilledEmail }).success) {
        autoVerifiedQueryEmailsRef.current.add(prefilledEmail);
        setEmailState(prefilledEmail);
        createTurnstileWidgetAttempt();
        setShowTurnstile(true);
        setTurnstileError(false);
      }
    }
  }, [
    params.email,
    storybookInitialState,
    initialError,
    isSignUp,
    isInviteCleared,
    flowState,
    tier,
    createTurnstileWidgetAttempt,
  ]);

  const handleEmailChange = useCallback(
    (value: string) => {
      setEmailState(value);
      setError('');
      // Reset provider state when email changes
      if (value !== email) {
        isTurnstileSubmissionPendingRef.current = false;
        createTurnstileWidgetAttempt();
        clearPendingSso();
        setAvailableProviders([]);
      }
    },
    [clearPendingSso, createTurnstileWidgetAttempt, email]
  );

  const lookupEmailProviderAndContinue = useCallback(
    async (generation: number) => {
      if (!email.trim()) {
        return;
      }

      const controller = new AbortController();
      discoveryRequestRef.current.controller?.abort();
      discoveryRequestRef.current.controller = controller;
      const isCurrent = () => !controller.signal.aborted && isCurrentDiscoveryRequest(generation);

      try {
        const checkResponse = await fetch('/api/sso/organizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
          signal: controller.signal,
        });

        const responseBody: unknown = await checkResponse.json().catch(() => undefined);
        if (!isCurrent()) return;
        if (!checkResponse.ok) {
          setIsVerifying(false);
          setShowTurnstile(false);
          setError(
            checkResponse.status === 429
              ? 'Too many attempts. Please try again later.'
              : 'Unable to find sign-in methods. Please try again.'
          );
          setFlowState('landing');
          return;
        }
        const parsedResponse = SignInDiscoveryResponseSchema.safeParse(responseBody);
        if (!parsedResponse.success) {
          setIsVerifying(false);
          setShowTurnstile(false);
          setError('Unable to find sign-in methods. Please try again.');
          setFlowState('landing');
          return;
        }
        const checkResult = parsedResponse.data;

        // SSO domain - redirect to WorkOS (only SSO option)
        if (checkResult.kind === 'sso') {
          if (!isCurrent()) return;
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

        if (checkResult.kind === 'new') {
          setIsNewUser(true);
          setIsVerifying(false);
          setAvailableProviders(orderNewAccountProviders(checkResult.providers));
          setFlowState('provider-select');
          setShowTurnstile(false);
          return;
        }

        setIsNewUser(false);
        const resolution = resolveSignInMethods(checkResult.providers);
        if (resolution.kind === 'automatic-oauth') {
          if (!isCurrent()) return;
          saveHint({
            lastEmail: email,
            lastAuthMethod: resolution.provider,
            lastLogin: new Date().toISOString(),
          });
          setIsVerifying(false);
          setShowTurnstile(false);
          setFlowState('redirecting');
          const callbackUrl = getSignInCallbackUrl(params);
          await signIn(resolution.provider, { callbackUrl });
          return;
        }
        if (resolution.kind === 'automatic-email') {
          if (!isCurrent()) return;
          await deliverMagicLink(generation);
          return;
        }
        if (resolution.kind === 'provider-select') {
          setIsVerifying(false);
          setShowTurnstile(false);
          setAvailableProviders(resolution.providers);
          setFlowState('provider-select');
          return;
        }
        setError(
          'No supported sign-in method is available for this account. Use a different email.'
        );
        setIsVerifying(false);
        setShowTurnstile(false);
        setFlowState('landing');
      } catch (_error) {
        if (!isCurrent()) return;
        setIsDeliveringMagicLink(false);
        console.error('[SignInForm] Error during email sign-in method discovery');
        setIsVerifying(false);
        setShowTurnstile(false);
        setError('Unable to find sign-in methods. Please try again.');
        setFlowState('landing');
      } finally {
        if (isCurrentDiscoveryRequest(generation)) {
          discoveryRequestRef.current.controller = null;
        }
      }
    },
    [deliverMagicLink, email, isCurrentDiscoveryRequest, params, saveHint]
  );

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (isTurnstileSubmissionPendingRef.current) return;
      retireTurnstileWidget();
      clearPendingSso();
      setError('');
      // Explicit provider-first sign-up chose Email before entering this form.
      // Preserve that choice so verified Turnstile success sends its magic link;
      // normal email-first sign-in has no pending method and performs discovery.
      if (!(isSignUp && pendingSignIn === 'email')) {
        setPendingSignIn(null);
      }

      const result = emailSchema.safeParse({ email });
      if (!result.success) {
        setError(result.error.issues[0]?.message || 'Invalid email');
        return;
      }

      // Show Turnstile for verification
      createTurnstileWidgetAttempt();
      setShowTurnstile(true);
      setTurnstileError(false);
    },
    [
      clearPendingSso,
      createTurnstileWidgetAttempt,
      email,
      isSignUp,
      pendingSignIn,
      retireTurnstileWidget,
    ]
  );

  const handleOAuthClick = useCallback(
    async (provider: AuthProviderId) => {
      createTurnstileWidgetAttempt();
      clearPendingSso();
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
    [clearPendingSso, createTurnstileWidgetAttempt, email, isSignUp]
  );

  const handleSSOContinue = useCallback(
    async (orgId: string) => {
      createTurnstileWidgetAttempt();
      setTurnstileError(false);
      setShowTurnstile(true);
      setPendingSignIn('workos');
      // Store orgId temporarily for turnstile success handler
      pendingSSOOrgIdRef.current = orgId;
    },
    [createTurnstileWidgetAttempt]
  );

  const sendMagicLinkAndGetRedirectOutcome = useCallback(async (): Promise<boolean> => {
    const generation = beginDiscoveryRequest();
    return deliverMagicLink(generation);
  }, [beginDiscoveryRequest, deliverMagicLink]);

  const handleSendMagicLink = useCallback(async (): Promise<void> => {
    await sendMagicLinkAndGetRedirectOutcome();
  }, [sendMagicLinkAndGetRedirectOutcome]);

  const handleTurnstileSuccess = useCallback(
    async (token: string, attemptId?: number) => {
      if (
        attemptId !== undefined &&
        (attemptId !== activeTurnstileAttemptRef.current || attemptId !== turnstileAttemptId)
      ) {
        return;
      }
      if (isTurnstileSubmissionPendingRef.current) return;
      isTurnstileSubmissionPendingRef.current = true;
      const discoveryGeneration = beginDiscoveryRequest();
      setIsVerifying(true);
      setTurnstileError(false);

      try {
        const verifyResponse = await fetch('/api/auth/verify-turnstile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const verifyResult = await verifyResponse.json();
        if (!isCurrentDiscoveryRequest(discoveryGeneration)) return;
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
          await deliverMagicLink(discoveryGeneration);
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
          await lookupEmailProviderAndContinue(discoveryGeneration);
          return;
        }

        // Edge case: Turnstile succeeded but no email or pendingSignIn
        // This shouldn't happen in normal flow, but handle gracefully
        console.warn('[SignInForm] Turnstile succeeded but no email or pendingSignIn');
        setIsVerifying(false);
        setShowTurnstile(false);
        setFlowState('landing');
      } catch (error) {
        if (!isCurrentDiscoveryRequest(discoveryGeneration)) return;
        console.error('[SignInForm] Error during sign-in flow:', error);
        setError('An error occurred. Please try again.');
        setShowTurnstile(false);
        setFlowState('landing');
        setIsVerifying(false);
      } finally {
        if (isCurrentDiscoveryRequest(discoveryGeneration)) {
          isTurnstileSubmissionPendingRef.current = false;
        }
      }
    },
    [
      beginDiscoveryRequest,
      turnstileAttemptId,
      activeTurnstileAttemptRef,
      email,
      params,
      pendingSignIn,
      lookupEmailProviderAndContinue,
      saveHint,
      deliverMagicLink,
      isCurrentDiscoveryRequest,
    ]
  );

  const handleTurnstileError = useCallback(
    (attemptId: number) => {
      // A retired widget can report an error after a retry, navigation, or a
      // newer verification has begun. It must not invalidate that newer flow.
      if (attemptId !== activeTurnstileAttemptRef.current) return;
      // Once this widget has successfully submitted, a later error is stale
      // relative to the verification/discovery it started. Only an unsubmitted
      // active replacement widget can transition into the retryable error.
      if (isTurnstileSubmissionPendingRef.current) return;

      retireTurnstileWidget();
      setIsVerifying(false);
      setTurnstileError(true);
    },
    [retireTurnstileWidget]
  );

  const handleRetryTurnstile = useCallback(() => {
    isTurnstileSubmissionPendingRef.current = false;
    createTurnstileWidgetAttempt();
    setTurnstileError(false);
    // The keyed widget remounts when its immutable attempt ID changes; no
    // delayed state write is needed, so reset/back/unmount cannot resurrect it.
    setShowTurnstile(true);
  }, [createTurnstileWidgetAttempt]);

  const handleProviderSelect = useCallback(
    async (provider: AuthProviderId): Promise<boolean> => {
      // If no email was entered, show Turnstile first
      if (email.trim() === '') {
        createTurnstileWidgetAttempt();
        setPendingSignIn(provider);
        setShowTurnstile(true);
        setTurnstileError(false);
        return false;
      }

      // Email was entered and verified, proceed with OAuth
      if (provider === 'email') {
        // For magic link on signup pages, validate email before sending
        if (isSignUp) {
          const validation = validateMagicLinkSignupEmail(email);
          if (!validation.valid) {
            setError(validation.error ?? 'Invalid email for signup');
            return false;
          }
        }
        // Handle magic link
        return sendMagicLinkAndGetRedirectOutcome();
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
        return true;
      } catch (error) {
        console.error('[SignInForm] OAuth sign-in failed:', error);
        setError('Failed to sign in. Please try again.');
        setFlowState('provider-select');
        return false;
      }
    },
    [params, email, sendMagicLinkAndGetRedirectOutcome, saveHint, createTurnstileWidgetAttempt]
  );

  const handleBack = useCallback(() => {
    isTurnstileSubmissionPendingRef.current = false;
    retireTurnstileWidget();
    clearPendingSso();
    setFlowState('landing');
    setShowTurnstile(false);
    setPendingSignIn(null);
    setTurnstileError(false);
    setError('');
    setAvailableProviders([]);
    setShowEmailInput(!isSignUp);
  }, [clearPendingSso, isSignUp, retireTurnstileWidget]);

  const handleShowEmailInput = useCallback(() => {
    retireTurnstileWidget();
    clearPendingSso();
    setShowEmailInput(true);
    setPendingSignIn('email');
  }, [clearPendingSso, retireTurnstileWidget]);

  const handleClearHint = useCallback(() => {
    isTurnstileSubmissionPendingRef.current = false;
    retireTurnstileWidget();
    clearPendingSso();
    clearHint();
    setEmailState('');
    setFlowState('landing');
    setShowEmailInput(true);
  }, [clearHint, clearPendingSso, retireTurnstileWidget]);

  const handleClearInvite = useCallback(() => {
    isTurnstileSubmissionPendingRef.current = false;
    retireTurnstileWidget();
    clearPendingSso();
    setIsInviteCleared(true);
    setEmailState('');
    // Clear invite params by navigating without them
    const newParams = new URLSearchParams(params);
    newParams.delete('email');
    newParams.delete('org');
    const query = newParams.toString();
    window.history.replaceState(
      {},
      '',
      query ? `${window.location.pathname}?${query}` : window.location.pathname
    );
    setFlowState('landing');
    setShowEmailInput(true);
  }, [clearPendingSso, params, retireTurnstileWidget]);

  return {
    flowState,
    tier,
    showTurnstile,
    isVerifying,
    isDeliveringMagicLink,
    showEmailInput,
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
    turnstileAttemptId,
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
  };
}
