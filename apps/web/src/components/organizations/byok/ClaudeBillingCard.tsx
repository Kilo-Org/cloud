'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
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

/**
 * Which connection the card shows: the person's personal account, their own
 * connection in an organization, or the organization's shared-services one.
 */
export type ClaudeBillingScope = 'personal' | 'member' | 'shared_services';

const CARD_TITLE = 'Claude (linked billing)';

const ELIGIBILITY_NOTE =
  'Linked billing works with Claude API organizations only. Claude Pro and Max subscriptions and cloud marketplace billing do not qualify.';
const APPROVAL_NOTE =
  'To link, sign in to Claude Console and approve the link there. Only an owner, admin, or billing admin of the Claude organization can approve.';
const REFUSED_BILLING_NOTE =
  'If Anthropic declines billing, Claude requests pause. Kilo does not fall back to Kilo credits.';

const SCOPE_COPY: Record<
  ClaudeBillingScope,
  { description: string; coverageNote: string | null; removeNote: string }
> = {
  personal: {
    description:
      'Pay Anthropic directly for your Claude usage in Kilo through your Claude API organization. No API key needed.',
    coverageNote: null,
    removeNote: 'Removing the link from Kilo restores normal BYOK or Kilo-credit routing.',
  },
  member: {
    description:
      'Pay Anthropic directly for the Claude requests you make in this organization through your own Claude API organization. No API key needed.',
    coverageNote:
      'Only your own requests are covered. Shared services such as code review are not.',
    removeNote: 'Removing the link from Kilo restores normal BYOK or Kilo-credit routing.',
  },
  shared_services: {
    description:
      'Link a Claude API organization for this organization. Kilo shared services, such as code review, then bill Anthropic directly instead of using Kilo credits.',
    coverageNote: 'Only shared services are covered. Members’ own links are separate.',
    removeNote:
      'Removing the link from Kilo stops shared services from billing it. Members’ own links are unchanged.',
  },
};

function ClaudeConsoleLink({ children }: { children: ReactNode }) {
  return (
    <a
      className="text-foreground underline underline-offset-4"
      href={CONNECTED_PLATFORMS_URL}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

function outcomeMessage(outcome: string, scope: ClaudeBillingScope) {
  switch (outcome) {
    case 'connected':
      // Only a personal link replaces the person's stored Anthropic API key.
      return scope === 'personal'
        ? 'Your Claude organization is linked. Any stored Anthropic API key was removed from Kilo. Revoke that key in Claude Console if nothing else uses it.'
        : 'Your Claude organization is linked.';
    case 'declined':
      return 'Linking did not complete. An owner, admin, or billing admin of your Claude organization must approve it.';
    case 'already_linked':
      return 'This Claude organization is already linked in Kilo, for another person, organization, or account. Remove that link first.';
    case 'forbidden':
      if (scope === 'shared_services') {
        return 'Only a Kilo organization owner or admin with access to this feature can link it.';
      }
      return scope === 'member'
        ? 'Only a member of this Kilo organization with access to this feature can link it.'
        : 'Claude linked billing is not available for your account yet.';
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
  scope?: ClaudeBillingScope;
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
  scope = 'personal',
  outcome,
  onConnect,
  onRemove,
  onRetry,
  connecting,
  removing,
  error,
}: ClaudeBillingCardViewProps) {
  const copy = SCOPE_COPY[scope];
  const refusal = status ? refusalMessage(status) : null;
  const connected = status?.state === 'connected' || status?.state === 'billing_unavailable';
  return (
    <Card>
      <CardHeader className="grid grid-cols-[1fr_auto] items-start gap-4 pb-4">
        <CardTitle>{CARD_TITLE}</CardTitle>
        {!status ? (
          <Skeleton className="h-5 w-20" />
        ) : status.state === 'connected' ? (
          <Badge variant="new">Linked</Badge>
        ) : status.state === 'billing_unavailable' ? (
          <Badge variant="destructive">Billing unavailable</Badge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {outcome && (outcome !== 'connected' || connected) ? (
          <Alert variant={outcome === 'connected' ? 'default' : 'destructive'}>
            <AlertDescription>{outcomeMessage(outcome, scope)}</AlertDescription>
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
            <p className="type-body text-muted-foreground">{copy.description}</p>
            {connected && status.connectedAt ? (
              <p className="type-body text-muted-foreground">
                Linked on {new Date(status.connectedAt).toLocaleDateString()}.
              </p>
            ) : null}
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
              <p className="type-body text-muted-foreground">
                {scope === 'shared_services'
                  ? 'Ask a Kilo organization owner or admin to manage Claude shared services.'
                  : 'Only direct members of this organization can link their own Claude organization.'}
              </p>
            ) : null}
            <p className="type-body">
              <ClaudeConsoleLink>Set a spend limit or unlink in Claude Console</ClaudeConsoleLink>
            </p>
            <details>
              <summary className="type-body text-muted-foreground hover:text-foreground w-fit cursor-pointer">
                How Linked billing with Claude Platform works
              </summary>
              <ul className="type-body text-muted-foreground mt-2 list-disc space-y-1 pl-5">
                <li>{ELIGIBILITY_NOTE}</li>
                <li>{APPROVAL_NOTE}</li>
                {copy.coverageNote ? <li>{copy.coverageNote}</li> : null}
                <li>{REFUSED_BILLING_NOTE}</li>
                {connected && status.canManage ? <li>{copy.removeNote}</li> : null}
              </ul>
            </details>
          </>
        ) : error ? null : (
          <Skeleton className="h-24 w-full" />
        )}
      </CardContent>
    </Card>
  );
}

function ClaudeBillingCardContent({
  organizationId,
  scope,
}: {
  organizationId?: string;
  scope: ClaudeBillingScope;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();
  const outcomeParam = scope === 'shared_services' ? 'claude_billing_shared' : 'claude_billing';
  const [outcome, setOutcome] = useState(() => searchParams.get(outcomeParam));
  useEffect(() => {
    const returned = searchParams.get(outcomeParam);
    if (!returned) return;
    setOutcome(returned);
    const params = new URLSearchParams(searchParams.toString());
    params.delete(outcomeParam);
    const query = params.toString();
    router.replace(`${window.location.pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [outcomeParam, router, searchParams]);
  const [connecting, setConnecting] = useState(false);
  const input = {
    organizationId,
    ...(scope === 'shared_services' ? { scope: 'shared_services' as const } : {}),
  };
  const statusQuery = useQuery(trpc.claudeBilling.status.queryOptions(input));
  const flagEnabled = useFeatureFlagEnabled(CLAUDE_PLATFORM_OAUTH_FLAG);
  const removeMutation = useMutation(
    trpc.claudeBilling.remove.mutationOptions({
      onSuccess: () => {
        setOutcome(null);
        return queryClient.invalidateQueries({
          queryKey: trpc.claudeBilling.status.queryKey(input),
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
  // Inherited access (a parent organization's admin, a Kilo admin) cannot hold
  // a member link, so there is nothing for that viewer to see or do.
  const cannotHoldMemberLink = scope === 'member' && statusQuery.data?.canManage === false;
  if (cannotHoldMemberLink && !hasConnection) return null;
  return (
    <ClaudeBillingCardView
      status={statusQuery.data}
      scope={scope}
      outcome={outcome}
      connecting={connecting}
      removing={removeMutation.isPending}
      error={
        needsSignIn
          ? 'Sign in again to manage this link.'
          : needsAdmin
            ? scope === 'shared_services'
              ? 'An organization owner or admin must manage Claude shared services.'
              : 'Only a member of this organization can manage this link.'
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
              if (removeMutation.isError && !statusQuery.isError) removeMutation.mutate(input);
              else void statusQuery.refetch();
            }
      }
      onConnect={
        launched
          ? () => {
              setConnecting(true);
              const query = new URLSearchParams({
                owner: scope === 'personal' ? 'personal' : (organizationId ?? 'personal'),
                return: window.location.pathname,
              });
              if (scope === 'shared_services') query.set('scope', 'shared_services');
              window.location.assign(`/claude/billing/connect?${query}`);
            }
          : undefined
      }
      onRemove={() => removeMutation.mutate(input)}
    />
  );
}

/**
 * One Claude billing connection card. `scope` picks which connection it shows;
 * the organization's shared-services card is rendered only for people who
 * manage the organization.
 */
export function ClaudeBillingCard({
  organizationId,
  scope = organizationId ? 'member' : 'personal',
}: {
  organizationId?: string;
  scope?: ClaudeBillingScope;
}) {
  return (
    <Suspense fallback={null}>
      <ClaudeBillingCardContent organizationId={organizationId} scope={scope} />
    </Suspense>
  );
}
