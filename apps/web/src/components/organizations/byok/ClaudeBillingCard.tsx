'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { ClaudeLogo } from '@/components/auth/ClaudeLogo';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { CLAUDE_PLATFORM_OAUTH_FLAG } from '@kilocode/web-shared/lib/auth/claude/feature-flag';
import type { ClaudeBillingStatus } from '@/routers/claude-billing-router';

const CONNECTED_PLATFORMS_URL = 'https://platform.claude.com/connected-platforms';

function outcomeMessage(outcome: string) {
  switch (outcome) {
    case 'connected':
      return 'Your Claude organization is linked. Any stored Anthropic API key was removed from Kilo. Revoke that key in Claude Console if nothing else uses it.';
    case 'declined':
      return 'Linking did not complete. An owner, admin, or billing admin of your Claude organization must approve it.';
    case 'already_linked':
      return 'This Claude organization is already linked to another Kilo account or organization. Ask that account’s administrator to unlink it first.';
    case 'forbidden':
      return 'Only a Kilo organization owner or admin with access to this feature can link it.';
    default:
      return 'We could not link your Claude organization. Try again.';
  }
}

function refusalMessage(status: ClaudeBillingStatus) {
  if (status.state === 'billing_unavailable') {
    return 'Claude billing is unavailable. The link may have ended, the Claude organization may be ineligible, or Kilo may have an authentication problem. Check Claude Console, link it again if needed, or contact Kilo support.';
  }
  switch (status.lastRefusalCode) {
    case 'linked_organization_spend_limit_reached':
      return 'A Claude spend limit was reached. Check both the Kilo linked billing cap and the organization’s monthly spend limit in Claude Console.';
    case 'linked_organization_billing_unavailable':
    case 'billing_error':
      return 'Anthropic cannot bill your Claude organization. Check its billing status and spend limits in Claude Console.';
    case 'permission_error':
      return 'Claude refused the request. Check model access and billing in Claude Console, or contact Kilo support.';
    default:
      return null;
  }
}

export type ClaudeBillingCardViewProps = {
  status: ClaudeBillingStatus | undefined;
  organizationId?: string;
  outcome?: string | null;
  onConnect?: () => void;
  onRemove?: () => void;
  onRetry?: () => void;
  connecting?: boolean;
  removing?: boolean;
  error?: string | null;
};

export function ClaudeBillingCardView({
  status,
  organizationId,
  outcome,
  onConnect,
  onRemove,
  onRetry,
  connecting,
  removing,
  error,
}: ClaudeBillingCardViewProps) {
  const refusal = status ? refusalMessage(status) : null;
  const connected = status?.state === 'connected' || status?.state === 'billing_unavailable';
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Linked billing with Claude Platform</CardTitle>
        {status ? (
          <Badge variant={status.state === 'billing_unavailable' ? 'destructive' : 'outline'}>
            {status.state === 'connected'
              ? 'Linked'
              : status.state === 'billing_unavailable'
                ? 'Billing unavailable'
                : 'Not linked'}
          </Badge>
        ) : (
          <Skeleton className="h-5 w-20" />
        )}
      </CardHeader>
      <CardContent className="flex min-h-[8rem] flex-col gap-3">
        {outcome && (outcome !== 'connected' || connected) ? (
          <Alert variant={outcome === 'connected' ? 'default' : 'destructive'}>
            <AlertDescription>{outcomeMessage(outcome)}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </Alert>
        ) : null}
        {refusal ? (
          <Alert variant="destructive">
            <AlertDescription>{refusal}</AlertDescription>
          </Alert>
        ) : null}
        {status ? (
          <>
            <p className="text-muted-foreground text-sm">
              Pay Anthropic for Claude usage in Kilo through your Claude API organization. No API
              key needed. Claude Pro and Max subscriptions and cloud marketplace billing do not
              qualify.
            </p>
            <p className="text-muted-foreground text-sm">
              You will go to Claude to approve. An owner, admin, or billing admin of your Claude
              organization must approve.
              {organizationId
                ? ' Only an owner or admin of this Kilo organization can start linking.'
                : ''}{' '}
              Claude requests pause if Anthropic refuses billing. Kilo does not fall back to Kilo
              credits.
            </p>
            {status.connectedAt && connected ? (
              <p className="text-muted-foreground text-xs">
                Linked {new Date(status.connectedAt).toLocaleDateString()}.
              </p>
            ) : null}
            <a
              className="text-sm underline underline-offset-4"
              href={CONNECTED_PLATFORMS_URL}
              target="_blank"
              rel="noreferrer"
            >
              Set a spend limit or unlink in Claude Console
            </a>
            {status.canManage && (onConnect || connected) ? (
              <div className="flex flex-wrap items-center gap-2">
                {onConnect ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={connecting || removing}
                    onClick={onConnect}
                    className="h-auto min-h-10 whitespace-normal text-left"
                  >
                    <ClaudeLogo />
                    {connecting
                      ? 'Redirecting to Claude…'
                      : connected
                        ? 'Link your Claude organization again'
                        : 'Link your Claude organization'}
                  </Button>
                ) : null}
                {connected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={connecting || removing}
                    onClick={onRemove}
                  >
                    {removing ? 'Removing…' : 'Remove from Kilo'}
                  </Button>
                ) : null}
              </div>
            ) : !status.canManage ? (
              <p className="text-muted-foreground text-sm">
                Ask a Kilo organization owner or admin to manage Claude billing.
              </p>
            ) : null}
            {connected && status.canManage ? (
              <p className="text-muted-foreground text-xs">
                Removing this link restores normal BYOK or Kilo-credit routing. It does not revoke
                consent in Claude Console.
              </p>
            ) : null}
          </>
        ) : error ? null : (
          <Skeleton className="h-24 w-full" />
        )}
      </CardContent>
    </Card>
  );
}

function ClaudeBillingCardContent({ organizationId }: { organizationId?: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [outcome, setOutcome] = useState(() => searchParams.get('claude_billing'));
  useEffect(() => {
    const returned = searchParams.get('claude_billing');
    if (!returned) return;
    setOutcome(returned);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('claude_billing');
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [router, searchParams]);
  const [connecting, setConnecting] = useState(false);
  const statusQuery = useQuery(trpc.claudeBilling.status.queryOptions({ organizationId }));
  const flagEnabled = useFeatureFlagEnabled(CLAUDE_PLATFORM_OAUTH_FLAG);
  const removeMutation = useMutation(
    trpc.claudeBilling.remove.mutationOptions({
      onSuccess: () => {
        setOutcome(null);
        return queryClient.invalidateQueries({
          queryKey: trpc.claudeBilling.status.queryKey({ organizationId }),
        });
      },
    })
  );
  const failureCode = statusQuery.error?.data?.code ?? removeMutation.error?.data?.code;
  const needsSignIn = failureCode === 'UNAUTHORIZED';
  const needsAdmin = failureCode === 'FORBIDDEN';
  // Before launch the card appears only for an owner who already has a
  // connection, so they can still see its state and remove it.
  const launched = flagEnabled === true;
  const hasConnection =
    statusQuery.data !== undefined && statusQuery.data.state !== 'not_connected';
  if (!launched && !hasConnection) return null;
  return (
    <ClaudeBillingCardView
      status={statusQuery.data}
      organizationId={organizationId}
      outcome={outcome}
      connecting={connecting}
      removing={removeMutation.isPending}
      error={
        needsSignIn
          ? 'Sign in again to manage this link.'
          : needsAdmin
            ? 'An organization owner or admin must manage this link.'
            : statusQuery.isError
              ? 'We could not load your Claude link.'
              : removeMutation.isError
                ? 'We could not remove your Claude link. Try again.'
                : null
      }
      onRetry={
        needsSignIn || needsAdmin
          ? undefined
          : () => {
              if (removeMutation.isError && !statusQuery.isError)
                removeMutation.mutate({ organizationId });
              else void statusQuery.refetch();
            }
      }
      onConnect={
        launched
          ? () => {
              setConnecting(true);
              const query = new URLSearchParams({
                owner: organizationId ?? 'personal',
                return: window.location.pathname,
              });
              window.location.assign(`/claude/billing/connect?${query}`);
            }
          : undefined
      }
      onRemove={() => removeMutation.mutate({ organizationId })}
    />
  );
}

export function ClaudeBillingCard({ organizationId }: { organizationId?: string }) {
  return (
    <Suspense fallback={null}>
      <ClaudeBillingCardContent organizationId={organizationId} />
    </Suspense>
  );
}
