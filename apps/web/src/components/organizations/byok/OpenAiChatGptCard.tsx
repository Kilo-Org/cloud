'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { OPENAI_TOKEN_SHARING_SCOPE } from '@/lib/auth/openai/scopes';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';

/**
 * The BYOK entry for a delegated "Sign in with ChatGPT" connection. It is not a
 * pasted API key: the person connects with one click and disconnects with one
 * click, and the state is always visible on the card itself.
 */

/** Where the connect call returns after OpenAI redirects back to the app. */
const BYOK_PATH = '/byok';

/**
 * The query parameter the OpenAI callback route appends when an authorization
 * is declined or fails (see `apps/web/src/app/testing/oai-redirect/route.ts`).
 */
const AUTH_ERROR_PARAM = 'openai_error';

/**
 * The card title names the connection, not the provider: the BYOK key list
 * below this card offers a pasted 'OpenAI API key' entry, so a bare 'OpenAI'
 * here would read as the same thing twice on one page.
 */
const CARD_TITLE = 'OpenAI (ChatGPT subscription)';

const CONNECT_DESCRIPTION =
  'Connect with your ChatGPT subscription to use OpenAI models in Kilo. No API key needed.';
const CONNECT_LABEL = 'Sign in with ChatGPT';
const RECONNECT_LABEL = 'Reconnect with ChatGPT';
const TRY_AGAIN_LABEL = 'Try again';
const DISCONNECT_LABEL = 'Disconnect';
/**
 * Pending labels. The connect round-trip leaves the app for OpenAI, so the
 * button stays in its busy state until the browser navigates (or the attempt
 * fails) instead of returning to its idle label while the redirect is in
 * flight. Same shape as the canonical Linear card's
 * 'Loading...'/'Disconnecting...' pair.
 */
const CONNECTING_LABEL = 'Redirecting to ChatGPT...';
const DISCONNECTING_LABEL = 'Disconnecting...';
const CONNECTED_LABEL = 'Connected';
const RECONNECT_BADGE_LABEL = 'Needs reconnect';
const FALLBACK_ERROR_MESSAGE = 'Your ChatGPT connection is not available. Reconnect to continue.';
const FALLBACK_IDENTITY_LABEL = 'your ChatGPT account';
const LOAD_ERROR_MESSAGE = "We couldn't load your ChatGPT connection. Try again.";
const DISCONNECT_ERROR_MESSAGE = "We couldn't disconnect ChatGPT. Try again.";

/**
 * Client-side code for a linking session that never started the OAuth
 * round-trip. It is fed through `authErrorCode`, so the card renders the same
 * generic connect-failure copy and try-again action as a returned OAuth error.
 */
const CONNECT_FAILED_CODE = 'connect_failed';

/**
 * Shared by every state so the card keeps one padding and one reserved height:
 * switching between loading, disconnected, connected and error never moves the
 * key list below it.
 */
const CARD_BODY_CLASS = 'flex min-h-[5.5rem] flex-col justify-center gap-3';
const CARD_ACTION_CLASS = 'w-fit';

/** The declined/failed authorization copy, keyed by the returned error code. */
function openAiChatGptAuthErrorMessage(code: string): string {
  return code === 'access_denied'
    ? 'ChatGPT was not connected. Try again.'
    : "We couldn't connect ChatGPT. Try again.";
}

/**
 * Starts the connect round-trip: first an account-linking session for the
 * signed-in person, then the OpenAI authorization with the token-sharing
 * scope. The linking session is what lets the callback attach this identity to
 * the current account (and skip the sign-in Turnstile gate); it must succeed
 * before the browser leaves for OpenAI.
 */
export async function startOpenAiChatGptConnect(
  createLinkingSession: () => Promise<unknown>
): Promise<void> {
  await createLinkingSession();
  await signIn('openai', { callbackUrl: BYOK_PATH }, { scope: OPENAI_TOKEN_SHARING_SCOPE });
}

/** The email claim, or the issuer-scoped subject when the token has no email. */
function connectionIdentity(status: OpenAiChatGptStatus): string {
  return status.email ?? status.subject ?? FALLBACK_IDENTITY_LABEL;
}

export type OpenAiChatGptCardViewProps = {
  /** `undefined` while the status query is loading. */
  status: OpenAiChatGptStatus | undefined;
  /**
   * A returned `openai_error` code. It renders as an alert above the stored
   * status body so the connection's indicator, identity and Disconnect action
   * stay visible (and usable) while the failure is reported.
   */
  authErrorCode?: string | null;
  /** The status query failed: show a message and a retry instead of a skeleton. */
  hasLoadError?: boolean;
  /** The last disconnect attempt failed: keep the retry action on the card. */
  hasDisconnectError?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRetry?: () => void;
  isConnecting?: boolean;
  isDisconnecting?: boolean;
};

function CardIndicator({ status }: Pick<OpenAiChatGptCardViewProps, 'status'>) {
  if (!status) {
    return null;
  }
  if (status.state === 'connected') {
    return <Badge variant="new">{CONNECTED_LABEL}</Badge>;
  }
  if (status.state === 'error') {
    return <Badge variant="destructive">{RECONNECT_BADGE_LABEL}</Badge>;
  }
  return null;
}

/**
 * The returned authorization error, shown as an alert above the stored status
 * body. The status body keeps its own actions, so the stored connection's
 * reconnect or connect CTA is the retry and Disconnect stays one click away.
 */
function AuthErrorAlert({ code }: { code: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{openAiChatGptAuthErrorMessage(code)}</AlertDescription>
    </Alert>
  );
}

function CardBody({
  status,
  hasLoadError,
  hasDisconnectError,
  onConnect,
  onDisconnect,
  onRetry,
  isConnecting,
  isDisconnecting,
}: OpenAiChatGptCardViewProps) {
  if (hasLoadError) {
    return (
      <>
        <p className="type-body text-muted-foreground">{LOAD_ERROR_MESSAGE}</p>
        <Button size="sm" className={CARD_ACTION_CLASS} onClick={onRetry}>
          {TRY_AGAIN_LABEL}
        </Button>
      </>
    );
  }

  if (!status) {
    // Same text lines and same action size as the connected body.
    return (
      <>
        <div className="space-y-1">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-5 w-40" />
        </div>
        <Skeleton className="h-8 w-36" />
      </>
    );
  }

  if (hasDisconnectError) {
    // A failed disconnect keeps the disconnect action so one more click
    // retries; the message replaces the identity line in the same body.
    return (
      <>
        <p className="type-body text-muted-foreground">{DISCONNECT_ERROR_MESSAGE}</p>
        <Button
          variant="outline"
          size="sm"
          className={CARD_ACTION_CLASS}
          onClick={onDisconnect}
          disabled={isDisconnecting}
        >
          {isDisconnecting ? DISCONNECTING_LABEL : DISCONNECT_LABEL}
        </Button>
      </>
    );
  }

  if (status.state === 'disconnected') {
    return (
      <>
        <p className="type-body text-muted-foreground">{CONNECT_DESCRIPTION}</p>
        <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? CONNECTING_LABEL : CONNECT_LABEL}
        </Button>
      </>
    );
  }

  if (status.state === 'connected') {
    return (
      <>
        <div className="space-y-1">
          <p className="type-body">Connected as {connectionIdentity(status)}</p>
          {status.connectedAt ? (
            <p className="type-body text-muted-foreground">
              Connected on {new Date(status.connectedAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          className={CARD_ACTION_CLASS}
          onClick={onDisconnect}
          disabled={isDisconnecting}
        >
          {isDisconnecting ? DISCONNECTING_LABEL : DISCONNECT_LABEL}
        </Button>
      </>
    );
  }

  // Expired or otherwise failed connection: the stored message says what
  // happened, reconnecting is the way out, and disconnect stays available so a
  // stored connection can always be removed in one click.
  return (
    <>
      <p className="type-body text-muted-foreground">
        {status.errorMessage ?? FALLBACK_ERROR_MESSAGE}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect} disabled={isConnecting}>
          {isConnecting ? CONNECTING_LABEL : RECONNECT_LABEL}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={CARD_ACTION_CLASS}
          onClick={onDisconnect}
          disabled={isDisconnecting}
        >
          {isDisconnecting ? DISCONNECTING_LABEL : DISCONNECT_LABEL}
        </Button>
      </div>
    </>
  );
}

/** The card in every state; the container below wires it to tRPC and OAuth. */
export function OpenAiChatGptCardView(props: OpenAiChatGptCardViewProps) {
  return (
    <Card>
      <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
        <div className="flex flex-col gap-2">
          <CardTitle>{CARD_TITLE}</CardTitle>
        </div>
        <CardIndicator status={props.status} />
      </CardHeader>
      <CardContent>
        <div className={CARD_BODY_CLASS}>
          {props.authErrorCode ? <AuthErrorAlert code={props.authErrorCode} /> : null}
          <CardBody {...props} />
        </div>
      </CardContent>
    </Card>
  );
}

function OpenAiChatGptCardConnected() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const openaiError = searchParams.get(AUTH_ERROR_PARAM);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  const [hasDisconnectError, setHasDisconnectError] = useState(false);
  // Held from the connect click until the browser leaves for OpenAI. The
  // linking-session mutation settles before `signIn` finishes the redirect, so
  // `linkMutation.isPending` alone would drop the busy state too early and make
  // the button look idle (and clickable) while the redirect is still in flight.
  const [isConnecting, setIsConnecting] = useState(false);

  // Show the returned error once, then strip it from the URL so a refresh does
  // not repeat the message.
  useEffect(() => {
    if (!openaiError) return;
    setAuthErrorCode(openaiError);
    router.replace(BYOK_PATH);
  }, [openaiError, router]);

  const statusQuery = useQuery(trpc.openAiChatGpt.status.queryOptions());
  const disconnectMutation = useMutation(
    trpc.openAiChatGpt.disconnect.mutationOptions({
      onSuccess: () => {
        setHasDisconnectError(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.openAiChatGpt.status.queryKey(),
        });
      },
      onError: () => {
        setHasDisconnectError(true);
      },
    })
  );

  const linkMutation = useMutation(trpc.user.linkAuthProvider.mutationOptions());

  const handleConnect = () => {
    // A retry starts from a clean state so the failure copy never overlaps the
    // new attempt.
    setAuthErrorCode(null);
    setIsConnecting(true);
    void startOpenAiChatGptConnect(() => linkMutation.mutateAsync({ provider: 'openai' })).catch(
      () => {
        // Only a failed attempt releases the busy state; a successful one
        // navigates away with the label still pending.
        setIsConnecting(false);
        setAuthErrorCode(CONNECT_FAILED_CODE);
      }
    );
  };

  const handleDisconnect = () => {
    setHasDisconnectError(false);
    disconnectMutation.mutate();
  };

  const handleRetryLoad = () => {
    void statusQuery.refetch();
  };

  return (
    <OpenAiChatGptCardView
      status={statusQuery.data}
      authErrorCode={authErrorCode}
      hasLoadError={statusQuery.isError}
      hasDisconnectError={hasDisconnectError}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onRetry={handleRetryLoad}
      isConnecting={isConnecting}
      isDisconnecting={disconnectMutation.isPending}
    />
  );
}

export function OpenAiChatGptCard() {
  // `useSearchParams` needs a Suspense boundary; the fallback is the card's own
  // loading state, so the reserved height covers it too.
  return (
    <Suspense fallback={<OpenAiChatGptCardView status={undefined} />}>
      <OpenAiChatGptCardConnected />
    </Suspense>
  );
}
