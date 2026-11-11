'use client';

import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ClaudeLogo } from '@/components/auth/ClaudeLogo';
import { useFeatureFlagEnabled } from 'posthog-js/react';
import { CLAUDE_PLATFORM_OAUTH_FLAG } from '@kilocode/web-shared/lib/auth/claude/feature-flag';
import type { ClaudeBillingOwnerInput } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import type { ClaudeBillingStatus } from '@/routers/claude-billing-router';

const subscribeHydration = () => () => {};
const CONNECTED_PLATFORMS_URL = 'https://platform.claude.com/connected-platforms';

/**
 * Which connection the card shows: the person's personal account, their own
 * connection in an organization, or the organization's shared-services one.
 */
export type ClaudeBillingScope = 'personal' | 'member' | 'shared_services';

const SCOPE_COPY: Record<
  ClaudeBillingScope,
  { title: string; description: string; manageNote: string; removeNote: string }
> = {
  personal: {
    title: 'Linked billing with Claude Platform',
    description:
      'Pay Anthropic for Claude usage in Kilo through your Claude API organization. No API key needed. Claude Pro and Max subscriptions and cloud marketplace billing do not qualify.',
    manageNote: '',
    removeNote:
      'Removing this link restores normal BYOK or Kilo-credit routing. Remove it first to switch to another Claude organization.',
  },
  member: {
    title: 'Linked billing with Claude Platform',
    description:
      'Pay Anthropic for the Claude requests you make in this organization through your Claude API organization. No API key needed. It does not cover shared services such as code review.',
    manageNote: '',
    removeNote:
      'Removing this link restores normal BYOK or Kilo-credit routing. Remove it first to switch to another Claude organization.',
  },
  shared_services: {
    title: 'Claude billing for shared services',
    description:
      'Link a Claude organization so Kilo shared services in this organization, such as code review, bill it instead of Kilo credits. Members’ own requests keep their separate billing choices.',
    manageNote: ' Only an owner or admin of this Kilo organization can link it.',
    removeNote:
      'Removing this link stops shared services from billing it. Members’ own links are unchanged. Remove it first to switch to another Claude organization.',
  },
};

function outcomeMessage(outcome: string, scope: ClaudeBillingScope, connected: boolean) {
  switch (outcome) {
    case 'connected':
      // Only a personal link replaces the person's stored Anthropic API key.
      return scope === 'personal'
        ? 'Your Claude organization is linked. Any stored Anthropic API key was removed from Kilo. Revoke that key in Claude Console if nothing else uses it.'
        : 'Your Claude organization is linked.';
    case 'declined':
      return connected
        ? 'Linking did not complete. An owner, admin, or billing admin of that Claude organization must approve it, or remove the current link first to link a different Claude organization.'
        : 'Linking did not complete. An owner, admin, or billing admin of your Claude organization must approve it.';
    case 'already_linked':
      return 'This Claude organization is already linked in Kilo. Use an existing link below if you control it, or ask its owner to share it.';
    case 'forbidden':
      if (scope === 'shared_services') {
        return 'Only a Kilo organization owner or admin with access to this feature can link it.';
      }
      return scope === 'member'
        ? 'Only a member of this Kilo organization with access to this feature can link it.'
        : 'Linked billing with Claude Platform is not available for your account yet.';
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
  onShare?: (source: ClaudeBillingOwnerInput) => void;
  onRemove?: () => void;
  onRetry?: () => void;
  connecting?: boolean;
  sharing?: boolean;
  removing?: boolean;
  error?: string | null;
};

export function ClaudeBillingCardView({
  status,
  scope = 'personal',
  outcome,
  onConnect,
  onShare,
  onRemove,
  onRetry,
  connecting,
  sharing,
  removing,
  error,
}: ClaudeBillingCardViewProps) {
  const copy = SCOPE_COPY[scope];
  const refusal = status ? refusalMessage(status) : null;
  const connected = status?.state === 'connected' || status?.state === 'billing_unavailable';
  const shareableLinks =
    !connected && status
      ? status.shareableLinks.length > 0
        ? status.shareableLinks
        : status.canSharePersonal
          ? [
              {
                payerId: 'personal',
                source: {},
                label: 'Personal account',
                connectedAt: null,
              },
            ]
          : []
      : [];
  const [selectedPayerId, setSelectedPayerId] = useState<string | null>(null);
  const selectedShareLink =
    shareableLinks.find(link => link.payerId === selectedPayerId) ?? shareableLinks[0];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{copy.title}</CardTitle>
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
            <AlertDescription>{outcomeMessage(outcome, scope, connected)}</AlertDescription>
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
            <p className="text-muted-foreground text-sm">{copy.description}</p>
            <p className="text-muted-foreground text-sm">
              You will go to Claude to approve. An owner, admin, or billing admin of your Claude
              organization must approve.
              {copy.manageNote} Claude requests pause if Anthropic refuses billing. Kilo does not
              fall back to Kilo credits.
            </p>
            {(status.connectedAt || status.sharedWith.length > 0) && connected ? (
              <p className="text-muted-foreground text-xs">
                {status.connectedAt
                  ? `Linked ${new Date(status.connectedAt).toLocaleDateString()}.`
                  : null}
                {status.connectedAt && status.sharedWith.length > 0 ? ' ' : null}
                {status.sharedWith.length > 0
                  ? `Shared with ${status.sharedWith.join(', ')}.`
                  : null}
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
            {status.canManage && (onConnect || (onShare && selectedShareLink) || connected) ? (
              <div className="flex flex-wrap items-center gap-2">
                {onConnect ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={connecting || sharing || removing}
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
                {onShare && selectedShareLink ? (
                  shareableLinks.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={selectedShareLink.payerId}
                        onValueChange={setSelectedPayerId}
                        disabled={connecting || sharing || removing}
                      >
                        <SelectTrigger
                          aria-label="Existing Claude link"
                          className="min-h-10 min-w-52"
                        >
                          <SelectValue>{selectedShareLink.label}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {shareableLinks.map(link => (
                            <SelectItem key={link.payerId} value={link.payerId}>
                              {link.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={connecting || sharing || removing}
                        onClick={() => onShare(selectedShareLink.source)}
                        className="h-auto min-h-10 whitespace-normal text-left"
                      >
                        <ClaudeLogo />
                        {sharing ? 'Applying Claude link…' : 'Use selected Claude link'}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={connecting || sharing || removing}
                      onClick={() => onShare(selectedShareLink.source)}
                      className="h-auto min-h-10 whitespace-normal text-left"
                    >
                      <ClaudeLogo />
                      {sharing
                        ? 'Applying Claude link…'
                        : selectedShareLink.source.organizationId === undefined &&
                            selectedShareLink.label === 'Personal account'
                          ? 'Use your personal Claude link'
                          : `Use Claude link from ${selectedShareLink.label}`}
                    </Button>
                  )
                ) : null}
                {connected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={connecting || sharing || removing}
                    onClick={onRemove}
                  >
                    {removing ? 'Removing…' : 'Remove from Kilo'}
                  </Button>
                ) : null}
              </div>
            ) : !status.canManage ? (
              <p className="text-muted-foreground text-sm">
                {scope === 'shared_services'
                  ? 'Ask a Kilo organization owner or admin to manage Claude shared services.'
                  : 'Join this Kilo organization as a member to link your own Claude organization here.'}
              </p>
            ) : null}
            {connected && status.canManage ? (
              <p className="text-muted-foreground text-xs">{copy.removeNote}</p>
            ) : null}
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
  const [lastShareSource, setLastShareSource] = useState<ClaudeBillingOwnerInput | null>(null);
  const input = {
    organizationId,
    ...(scope === 'shared_services' ? { scope: 'shared_services' as const } : {}),
  };
  const statusQuery = useQuery(trpc.claudeBilling.status.queryOptions(input));
  const flagEnabled = useFeatureFlagEnabled(CLAUDE_PLATFORM_OAUTH_FLAG);
  const invalidateBillingQueries = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.claudeBilling.status.pathFilter()),
      queryClient.invalidateQueries(trpc.byok.previewRouting.pathFilter()),
      ...(scope === 'personal' ? [queryClient.invalidateQueries(trpc.byok.list.pathFilter())] : []),
    ]);
  const shareMutation = useMutation(
    trpc.claudeBilling.share.mutationOptions({
      onSuccess: () => {
        setOutcome('connected');
        return invalidateBillingQueries();
      },
    })
  );
  const removeMutation = useMutation(
    trpc.claudeBilling.remove.mutationOptions({
      onSuccess: () => {
        setOutcome(null);
        return invalidateBillingQueries();
      },
    })
  );
  const shareFailureCode = shareMutation.error?.data?.code;
  const failureCode =
    statusQuery.error?.data?.code ?? shareFailureCode ?? removeMutation.error?.data?.code;
  const needsSignIn = failureCode === 'UNAUTHORIZED';
  const needsAdmin = failureCode === 'FORBIDDEN';
  const nonRetryableShareError =
    shareFailureCode === 'CONFLICT' || shareFailureCode === 'PRECONDITION_FAILED';
  // Before launch the card appears only for an owner who already has a
  // connection, so they can still see its state and remove it.
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false
  );
  const launched = hydrated && flagEnabled === true;
  const hasConnection =
    statusQuery.data !== undefined && statusQuery.data.state !== 'not_connected';
  if (!launched && !hasConnection) return null;
  return (
    <ClaudeBillingCardView
      status={statusQuery.data}
      scope={scope}
      outcome={outcome}
      connecting={connecting}
      sharing={shareMutation.isPending}
      removing={removeMutation.isPending}
      error={
        needsSignIn
          ? 'Sign in again to manage this link.'
          : needsAdmin
            ? scope === 'shared_services'
              ? 'An organization owner or admin must manage Claude shared services.'
              : scope === 'member'
                ? 'Only a member of this organization can manage this link.'
                : 'Linked billing with Claude Platform is not available for your account yet.'
            : shareFailureCode === 'CONFLICT'
              ? 'This scope already has a Claude link. Remove it from Kilo first to use another link.'
              : shareFailureCode === 'PRECONDITION_FAILED'
                ? 'That Claude link is no longer connected. Link a Claude organization first, then share it here.'
                : statusQuery.isError
                  ? 'We could not load your Claude link.'
                  : shareMutation.isError
                    ? 'We could not share that Claude link. Try again.'
                    : removeMutation.isError
                      ? 'We could not remove your Claude link. Try again.'
                      : null
      }
      onRetry={
        needsSignIn || needsAdmin || nonRetryableShareError
          ? undefined
          : () => {
              if (shareMutation.isError && !statusQuery.isError && lastShareSource) {
                shareMutation.mutate({ source: lastShareSource, target: input });
              } else if (removeMutation.isError && !statusQuery.isError) {
                removeMutation.mutate(input);
              } else {
                void statusQuery.refetch();
              }
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
      onShare={
        launched && (statusQuery.data?.shareableLinks.length ?? 0) > 0
          ? source => {
              removeMutation.reset();
              setLastShareSource(source);
              shareMutation.mutate({ source, target: input });
            }
          : undefined
      }
      onRemove={() => {
        shareMutation.reset();
        removeMutation.mutate(input);
      }}
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
