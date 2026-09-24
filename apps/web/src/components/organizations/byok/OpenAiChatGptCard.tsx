'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { openAiChatGptByokPath, startOpenAiChatGptConnect } from '@/lib/auth/openai/connect';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';
import { ChatGptUsageLinkView } from '@/components/chatgpt/ChatGptUsageLink';
import { ChatGptUsageLimitDialog } from '@/components/chatgpt/ChatGptUsageLimitDialog';

/**
 * The BYOK entry for a delegated "Sign in with ChatGPT" connection. It is not a
 * pasted API key: the person connects with one click and disconnects with one
 * click, and the state is always visible on the card itself.
 */

/**
 * The query parameter the OpenAI callback route appends when an authorization
 * is declined or fails (see `apps/web/src/app/auth/openai/callback/route.ts`).
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
/**
 * The organization variant. The connection is personal, so the copy must not
 * read as an organization-wide setting that one member configures for everyone.
 */
const ORGANIZATION_CONNECT_DESCRIPTION =
  'Connect your own ChatGPT subscription. This connection is yours and applies only to your requests in this organization.';
const ORGANIZATION_SCOPE_NOTE =
  'This connection is yours and applies only to your requests in this organization.';
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
 * key list below it. The minimum fits the tallest body at the narrowest
 * supported width (375px): the returned-authorization alert above its one
 * action row. The alert is part of this reservation (see `CardBody`), so it
 * never adds a row on top of the body and the error page keeps the same offset
 * as the clean page.
 */
const CARD_BODY_CLASS = 'flex min-h-[7rem] flex-col justify-center gap-3';

/**
 * The header's status column. It is rendered in every state, including the
 * loading skeleton, and keeps room for the longest indicator label
 * ('Needs reconnect'), so the title wraps to the same number of lines whether
 * or not the card currently shows an indicator. Sizing the column to the badge
 * alone makes the resolved expired card one title line taller than the loading
 * skeleton at 375px, which pushes the key list 23px down when the status
 * arrives.
 */
const CARD_STATUS_SLOT_CLASS = 'flex min-w-[7.625rem] justify-end';

const CARD_ACTION_CLASS = 'w-fit';

/** The declined/failed authorization copy, keyed by the returned error code. */
function openAiChatGptAuthErrorMessage(code: string): string {
  return code === 'access_denied'
    ? 'ChatGPT was not connected. Try again.'
    : "We couldn't connect ChatGPT. Try again.";
}

/** The email claim, or the issuer-scoped subject when the token has no email. */
function connectionIdentity(status: OpenAiChatGptStatus): string {
  return status.email ?? status.subject ?? FALLBACK_IDENTITY_LABEL;
}

export type OpenAiChatGptCardViewProps = {
  /** `undefined` while the status query is loading. */
  status: OpenAiChatGptStatus | undefined;
  /**
   * A returned `openai_error` code. It renders as the body's own alert, in the
   * reserved height, so the page never moves when it mounts; the stored
   * connection's indicator and actions stay visible beside it.
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
  /** Organization scope: the connection is the member's own, not the organization's. */
  isOrganization?: boolean;
  /** The recorded plan limit is dismissed: the card stops showing the message. */
  isUsageLimitDismissed?: boolean;
  onDismissUsageLimit?: () => void;
};

/**
 * The connection's own indicator. It renders inside the reserved status column
 * (`CARD_STATUS_SLOT_CLASS`) so its label never changes how the title wraps.
 */
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
 * The returned authorization error, rendered as the body's message inside the
 * reserved height. The body keeps the stored connection's actions, so the
 * reconnect or connect control is the retry and Disconnect stays one click
 * away.
 */
function AuthErrorAlert({ code }: { code: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{openAiChatGptAuthErrorMessage(code)}</AlertDescription>
    </Alert>
  );
}

/**
 * The expired/failed connection's pair of actions: reconnect in place, or
 * remove the stored connection. Shared with the returned-failure body so a
 * declined reconnect keeps both controls instead of collapsing to a bare
 * retry.
 */
function ReconnectDisconnectActions({
  onConnect,
  onDisconnect,
  isConnecting,
  isDisconnecting,
}: Pick<
  OpenAiChatGptCardViewProps,
  'onConnect' | 'onDisconnect' | 'isConnecting' | 'isDisconnecting'
>) {
  return (
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
  );
}

function CardBody({
  status,
  authErrorCode,
  hasLoadError,
  hasDisconnectError,
  onConnect,
  onDisconnect,
  onRetry,
  isConnecting,
  isDisconnecting,
  isOrganization,
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

  if (authErrorCode && status?.state !== 'connected') {
    // A returned authorization failure is the card's message for this load: it
    // fills the body's single message slot (and carries the retry itself)
    // instead of stacking a second row above the stored body, so the reserved
    // height already covers it and the key list below the card stays put. The
    // stored connection keeps its own actions, so a declined reconnect still
    // offers its Reconnect and Disconnect controls.
    //
    // A live `connected` status is left out on purpose: there is nothing to
    // recover, and a failure alert beside 'Connected as ...' would contradict
    // the connection the card is reporting.
    return (
      <>
        <AuthErrorAlert code={authErrorCode} />
        {status?.state === 'error' ? (
          <ReconnectDisconnectActions
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            isConnecting={isConnecting}
            isDisconnecting={isDisconnecting}
          />
        ) : (
          <Button
            size="sm"
            className={CARD_ACTION_CLASS}
            onClick={onConnect}
            disabled={isConnecting}
          >
            {isConnecting ? CONNECTING_LABEL : TRY_AGAIN_LABEL}
          </Button>
        )}
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
    // The plain connect state. A returned or local connect failure takes the
    // branch above, so this body is only reached without an error code.
    return (
      <>
        <p className="type-body text-muted-foreground">
          {isOrganization ? ORGANIZATION_CONNECT_DESCRIPTION : CONNECT_DESCRIPTION}
        </p>
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
          {isOrganization ? (
            <p className="type-body text-muted-foreground">{ORGANIZATION_SCOPE_NOTE}</p>
          ) : null}
        </div>
        <ChatGptUsageLinkView />
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
      <ReconnectDisconnectActions
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        isConnecting={isConnecting}
        isDisconnecting={isDisconnecting}
      />
    </>
  );
}

/** The card in every state; the container below wires it to tRPC and OAuth. */
export function OpenAiChatGptCardView(props: OpenAiChatGptCardViewProps) {
  return (
    <>
      <Card>
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
          <div className="flex flex-col gap-2">
            <CardTitle>{CARD_TITLE}</CardTitle>
          </div>
          <div className={CARD_STATUS_SLOT_CLASS}>
            <CardIndicator status={props.status} />
          </div>
        </CardHeader>
        <CardContent>
          <div className={CARD_BODY_CLASS}>
            <CardBody {...props} />
          </div>
        </CardContent>
      </Card>
      {props.status?.usageLimit && !props.isUsageLimitDismissed ? (
        <ChatGptUsageLimitDialog open onDismiss={() => props.onDismissUsageLimit?.()} />
      ) : null}
    </>
  );
}

function OpenAiChatGptCardConnected({ organizationId }: { organizationId?: string }) {
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

  // The message is dismissed per recorded limit, so a later limit shows it
  // again instead of staying hidden for the rest of the session.
  const [dismissedUsageLimitReachedAt, setDismissedUsageLimitReachedAt] = useState<string | null>(
    null
  );

  const ownerInput = organizationId ? { organizationId } : {};

  // Show the returned error once, then strip it from the URL so a refresh does
  // not repeat the message.
  useEffect(() => {
    if (!openaiError) return;
    setAuthErrorCode(openaiError);
    router.replace(openAiChatGptByokPath(organizationId));
  }, [openaiError, organizationId, router]);

  const statusQuery = useQuery(trpc.openAiChatGpt.status.queryOptions(ownerInput));
  const disconnectMutation = useMutation(
    trpc.openAiChatGpt.disconnect.mutationOptions({
      onSuccess: () => {
        setHasDisconnectError(false);
        void queryClient.invalidateQueries({
          queryKey: trpc.openAiChatGpt.status.queryKey(ownerInput),
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
    void startOpenAiChatGptConnect(
      () =>
        linkMutation.mutateAsync(
          organizationId ? { provider: 'openai', organizationId } : { provider: 'openai' }
        ),
      organizationId
    ).catch(() => {
      // Only a failed attempt releases the busy state; a successful one
      // navigates away with the label still pending.
      setIsConnecting(false);
      setAuthErrorCode(CONNECT_FAILED_CODE);
    });
  };

  const handleDisconnect = () => {
    setHasDisconnectError(false);
    disconnectMutation.mutate(ownerInput);
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
      isOrganization={Boolean(organizationId)}
      isUsageLimitDismissed={
        statusQuery.data?.usageLimit?.reachedAt === dismissedUsageLimitReachedAt
      }
      onDismissUsageLimit={() => {
        setDismissedUsageLimitReachedAt(statusQuery.data?.usageLimit?.reachedAt ?? null);
      }}
    />
  );
}

export function OpenAiChatGptCard({ organizationId }: { organizationId?: string }) {
  // `useSearchParams` needs a Suspense boundary; the fallback is the card's own
  // loading state, so the reserved height covers it too.
  return (
    <Suspense
      fallback={
        <OpenAiChatGptCardView status={undefined} isOrganization={Boolean(organizationId)} />
      }
    >
      <OpenAiChatGptCardConnected organizationId={organizationId} />
    </Suspense>
  );
}
