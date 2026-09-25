'use client';
import * as React from 'react';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatGptUsageLimitDialog } from '@/components/chatgpt/ChatGptUsageLimitDialog';
import { ChatGptUsageLinkView } from '@/components/chatgpt/ChatGptUsageLinkView';
import { openAiChatGptByokPath, startOpenAiChatGptConnect } from '@/lib/auth/openai/connect';
import type { OpenAiChatGptStatus } from '@/lib/ai-gateway/openai-chatgpt/status';

/**
 * The organization's shared-services ChatGPT connection. It is one connection
 * per organization, it is not any member's own connection, and Kilo's shared
 * services (code reviews, the Slack bot, auto-triage) use it instead of
 * spending a member's plan.
 */

const CARD_TITLE = 'OpenAI (ChatGPT) for shared services';
const DESCRIPTION =
  'Connect an OpenAI account for this organization. Kilo shared services use it instead of a member’s own ChatGPT plan.';
const CONNECT_LABEL = 'Connect an OpenAI account';
const RECONNECT_LABEL = 'Reconnect';
const TRY_AGAIN_LABEL = 'Try again';
const DISCONNECT_LABEL = 'Disconnect';
const CONNECTING_LABEL = 'Redirecting to ChatGPT...';
const DISCONNECTING_LABEL = 'Disconnecting...';
const CONNECTED_LABEL = 'Connected';
const RECONNECT_BADGE_LABEL = 'Needs reconnect';
const SCOPE_NOTE =
  'Shared services in this organization use this account. It is not your own connection.';
const FALLBACK_IDENTITY_LABEL = 'your ChatGPT account';
const FALLBACK_ERROR_MESSAGE =
  'The shared services ChatGPT connection is not available. Reconnect to continue.';
const LOAD_ERROR_MESSAGE = "We couldn't load the shared services connection. Try again.";
const CONNECT_ERROR_MESSAGE = "We couldn't connect the shared services account. Try again.";
const DISCONNECT_ERROR_MESSAGE =
  "We couldn't disconnect the shared services connection. Try again.";
const CONNECT_FAILED_CODE = 'connect_failed';

const CARD_BODY_CLASS = 'flex min-h-[7rem] flex-col justify-center gap-3';
const CARD_STATUS_SLOT_CLASS = 'flex min-w-[7.625rem] justify-end';
const CARD_ACTION_CLASS = 'w-fit';

/**
 * The connection is an organization setting, so only a person who manages the
 * organization may connect, reconnect or disconnect it. Membership alone is not
 * enough, and the server enforces the same rule.
 */
export function canManageSharedServices(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export type ChatGptSharedServicesCardViewProps = {
  /** `undefined` while the status query is loading. */
  status: OpenAiChatGptStatus | undefined;
  hasLoadError?: boolean;
  hasDisconnectError?: boolean;
  /** A returned `openai_error` code from a failed authorization. */
  authErrorCode?: string | null;
  isConnecting?: boolean;
  isDisconnecting?: boolean;
  isUsageLimitDismissed?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRetry?: () => void;
  onDismissUsageLimit?: () => void;
};

/** The email claim, or the issuer-scoped subject when the token has no email. */
function connectionIdentity(status: OpenAiChatGptStatus): string {
  return status.email ?? status.subject ?? FALLBACK_IDENTITY_LABEL;
}

function DisconnectAction({
  onDisconnect,
  isDisconnecting,
}: Pick<ChatGptSharedServicesCardViewProps, 'onDisconnect' | 'isDisconnecting'>) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={CARD_ACTION_CLASS}
      onClick={onDisconnect}
      disabled={isDisconnecting}
    >
      {isDisconnecting ? DISCONNECTING_LABEL : DISCONNECT_LABEL}
    </Button>
  );
}

function ConnectAction({
  label,
  onConnect,
  isConnecting,
}: Pick<ChatGptSharedServicesCardViewProps, 'onConnect' | 'isConnecting'> & { label: string }) {
  return (
    <Button size="sm" className={CARD_ACTION_CLASS} onClick={onConnect} disabled={isConnecting}>
      {isConnecting ? CONNECTING_LABEL : label}
    </Button>
  );
}

function CardBody({
  status,
  hasLoadError,
  hasDisconnectError,
  authErrorCode,
  isConnecting,
  isDisconnecting,
  onConnect,
  onDisconnect,
  onRetry,
}: ChatGptSharedServicesCardViewProps) {
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

  if (authErrorCode) {
    return (
      <>
        <p className="type-body text-muted-foreground">{CONNECT_ERROR_MESSAGE}</p>
        <ConnectAction label={TRY_AGAIN_LABEL} onConnect={onConnect} isConnecting={isConnecting} />
      </>
    );
  }

  if (hasDisconnectError) {
    return (
      <>
        <p className="type-body text-muted-foreground">{DISCONNECT_ERROR_MESSAGE}</p>
        <DisconnectAction onDisconnect={onDisconnect} isDisconnecting={isDisconnecting} />
      </>
    );
  }

  if (!status) {
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

  if (status.state === 'connected') {
    return (
      <>
        <div className="space-y-1">
          <p className="type-body">Connected as {connectionIdentity(status)}</p>
          <p className="type-body text-muted-foreground">{SCOPE_NOTE}</p>
        </div>
        <ChatGptUsageLinkView />
        <DisconnectAction onDisconnect={onDisconnect} isDisconnecting={isDisconnecting} />
      </>
    );
  }

  if (status.state === 'error') {
    return (
      <>
        <p className="type-body text-muted-foreground">
          {status.errorMessage ?? FALLBACK_ERROR_MESSAGE}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectAction
            label={RECONNECT_LABEL}
            onConnect={onConnect}
            isConnecting={isConnecting}
          />
          <DisconnectAction onDisconnect={onDisconnect} isDisconnecting={isDisconnecting} />
        </div>
      </>
    );
  }

  return (
    <>
      <p className="type-body text-muted-foreground">{DESCRIPTION}</p>
      <ConnectAction label={CONNECT_LABEL} onConnect={onConnect} isConnecting={isConnecting} />
    </>
  );
}

/** The card in every state; the container below wires it to tRPC and OAuth. */
export function ChatGptSharedServicesCardView(props: ChatGptSharedServicesCardViewProps) {
  const status = props.status;
  return (
    <>
      <Card>
        <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
          <CardTitle>{CARD_TITLE}</CardTitle>
          <div className={CARD_STATUS_SLOT_CLASS}>
            {status?.state === 'connected' ? <Badge variant="new">{CONNECTED_LABEL}</Badge> : null}
            {status?.state === 'error' ? (
              <Badge variant="destructive">{RECONNECT_BADGE_LABEL}</Badge>
            ) : null}
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

const AUTH_ERROR_PARAM = 'openai_error';

function ChatGptSharedServicesCardConnected({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const openaiError = searchParams.get(AUTH_ERROR_PARAM);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  const [hasDisconnectError, setHasDisconnectError] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [dismissedUsageLimitReachedAt, setDismissedUsageLimitReachedAt] = useState<string | null>(
    null
  );

  const ownerInput = { organizationId, scope: 'shared_services' as const };

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
    setAuthErrorCode(null);
    setIsConnecting(true);
    void startOpenAiChatGptConnect(
      () =>
        linkMutation.mutateAsync({
          provider: 'openai',
          organizationId,
          chatGptScope: 'shared_services',
        }),
      organizationId
    ).catch(() => {
      setIsConnecting(false);
      setAuthErrorCode(CONNECT_FAILED_CODE);
    });
  };

  const handleDisconnect = () => {
    setHasDisconnectError(false);
    disconnectMutation.mutate(ownerInput);
  };

  return (
    <ChatGptSharedServicesCardView
      status={statusQuery.data}
      authErrorCode={authErrorCode}
      hasLoadError={statusQuery.isError}
      hasDisconnectError={hasDisconnectError}
      isConnecting={isConnecting}
      isDisconnecting={disconnectMutation.isPending}
      isUsageLimitDismissed={
        statusQuery.data?.usageLimit?.reachedAt === dismissedUsageLimitReachedAt
      }
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onRetry={() => void statusQuery.refetch()}
      onDismissUsageLimit={() =>
        setDismissedUsageLimitReachedAt(statusQuery.data?.usageLimit?.reachedAt ?? null)
      }
    />
  );
}

/**
 * The card on the organization BYOK page. `useSearchParams` needs a Suspense
 * boundary; the fallback is the card's own loading state.
 */
export function ChatGptSharedServicesCard({ organizationId }: { organizationId: string }) {
  return (
    <Suspense fallback={<ChatGptSharedServicesCardView status={undefined} />}>
      <ChatGptSharedServicesCardConnected organizationId={organizationId} />
    </Suspense>
  );
}
