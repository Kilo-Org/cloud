'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

const CONNECT_DESCRIPTION =
  'Connect with your ChatGPT subscription to use OpenAI models in Kilo. No API key needed.';
const CONNECT_LABEL = 'Sign in with ChatGPT';
const RECONNECT_LABEL = 'Reconnect with ChatGPT';
const TRY_AGAIN_LABEL = 'Try again';
const DISCONNECT_LABEL = 'Disconnect';
const CONNECTED_LABEL = 'Connected';
const RECONNECT_BADGE_LABEL = 'Needs reconnect';
const FALLBACK_ERROR_MESSAGE = 'Your ChatGPT connection is not available. Reconnect to continue.';
const FALLBACK_IDENTITY_LABEL = 'your ChatGPT account';
const LOAD_ERROR_MESSAGE = "We couldn't load your ChatGPT connection. Try again.";

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

function connectWithChatGpt(): Promise<unknown> {
  return signIn('openai', { callbackUrl: BYOK_PATH }, { scope: OPENAI_TOKEN_SHARING_SCOPE });
}

/** The email claim, or the issuer-scoped subject when the token has no email. */
function connectionIdentity(status: OpenAiChatGptStatus): string {
  return status.email ?? status.subject ?? FALLBACK_IDENTITY_LABEL;
}

export type OpenAiChatGptCardViewProps = {
  /** `undefined` while the status query is loading. */
  status: OpenAiChatGptStatus | undefined;
  /** A returned `openai_error` code, shown instead of the stored status. */
  authErrorCode?: string | null;
  /** The status query failed: show a message and a retry instead of a skeleton. */
  hasLoadError?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRetry?: () => void;
  isDisconnecting?: boolean;
};

function CardIndicator({
  status,
  authErrorCode,
}: Pick<OpenAiChatGptCardViewProps, 'status' | 'authErrorCode'>) {
  if (authErrorCode || !status) {
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

function CardBody({
  status,
  authErrorCode,
  hasLoadError,
  onConnect,
  onDisconnect,
  onRetry,
  isDisconnecting,
}: OpenAiChatGptCardViewProps) {
  if (authErrorCode) {
    return (
      <>
        <p className="type-body text-muted-foreground">
          {openAiChatGptAuthErrorMessage(authErrorCode)}
        </p>
        <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect}>
          {TRY_AGAIN_LABEL}
        </Button>
      </>
    );
  }

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

  if (status.state === 'disconnected') {
    return (
      <>
        <p className="type-body text-muted-foreground">{CONNECT_DESCRIPTION}</p>
        <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect}>
          {CONNECT_LABEL}
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
          {DISCONNECT_LABEL}
        </Button>
      </>
    );
  }

  // Expired or otherwise failed connection: the stored message says what
  // happened, and reconnecting is the way out.
  return (
    <>
      <p className="type-body text-muted-foreground">
        {status.errorMessage ?? FALLBACK_ERROR_MESSAGE}
      </p>
      <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect}>
        {RECONNECT_LABEL}
      </Button>
    </>
  );
}

/** The card in every state; the container below wires it to tRPC and OAuth. */
export function OpenAiChatGptCardView(props: OpenAiChatGptCardViewProps) {
  return (
    <Card>
      <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
        <div className="flex flex-col gap-2">
          <CardTitle>OpenAI</CardTitle>
        </div>
        <CardIndicator status={props.status} authErrorCode={props.authErrorCode} />
      </CardHeader>
      <CardContent>
        <div className={CARD_BODY_CLASS}>
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
        void queryClient.invalidateQueries({
          queryKey: trpc.openAiChatGpt.status.queryKey(),
        });
      },
    })
  );

  const handleConnect = () => {
    void connectWithChatGpt();
  };

  const handleDisconnect = () => {
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
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onRetry={handleRetryLoad}
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
