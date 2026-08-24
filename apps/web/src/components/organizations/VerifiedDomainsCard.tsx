'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  Globe2,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm, type ConfirmOptions } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { RootRouter } from '@/routers/root-router';
import { canManageOrganization } from '@kilocode/app-shared/organizations';

type VerifiedDomainClaim =
  inferRouterOutputs<RootRouter>['organizations']['verifiedDomains']['list'][number];
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
type OpenExternal = (url?: string | URL, target?: string, features?: string) => Window | null;

type VerifiedDomainsCardViewProps = {
  claims: VerifiedDomainClaim[];
  domain: string;
  errorMessage?: string;
  isCreating: boolean;
  isLoading: boolean;
  isMutating: boolean;
  isRetrying: boolean;
  onCheckStatus: (claimId: string) => void;
  onClaim: (domain: string) => void;
  onDomainChange: (domain: string) => void;
  onRemove: (claimId: string) => void;
  onRetryLoad: () => void;
  onVerify: (domain: string) => void;
  confirm: Confirm;
};

export function canViewVerifiedDomainsCard(role: OrganizationRole, isKiloAdmin = false): boolean {
  return isKiloAdmin || canManageOrganization(role);
}

export function openVerificationPortal(
  verificationLink: string,
  openExternal: OpenExternal = window.open
): void {
  try {
    openExternal(verificationLink, '_blank', 'noopener,noreferrer');
  } catch {
    // The pending claim remains available for a later retry.
  }
}

export function reserveVerificationPortal(openExternal: OpenExternal = window.open): Window | null {
  let portal: Window | null = null;
  try {
    portal = openExternal('', '_blank');
    if (portal) portal.opener = null;
    return portal;
  } catch {
    closeVerificationPortal(portal);
    return null;
  }
}

export function showVerificationPortal(
  portal: Window | null,
  verificationLink: string,
  openExternal: OpenExternal = window.open
): void {
  try {
    if (portal && !portal.closed) {
      portal.location.href = verificationLink;
      return;
    }
  } catch {
    closeVerificationPortal(portal);
  }
  openVerificationPortal(verificationLink, openExternal);
}

export function closeVerificationPortal(portal: Window | null): void {
  try {
    if (portal && !portal.closed) portal.close();
  } catch {
    // A stale or cross-origin WindowProxy may reject inspection or closure.
  }
}

export async function confirmVerifiedDomainRemoval(
  confirm: Confirm,
  claim: Pick<VerifiedDomainClaim, 'domain' | 'id' | 'status'>,
  onRemove: (claimId: string) => void
): Promise<void> {
  const confirmed = await confirm({
    title: `Remove ${claim.domain}?`,
    description:
      claim.status === 'verified'
        ? 'This stops future automatic joins for this domain. Current members remain in the organization.'
        : 'This cancels domain verification. The pending claim will be removed.',
    confirmLabel: 'Remove domain',
    destructive: true,
  });
  if (confirmed) onRemove(claim.id);
}

export function VerifiedDomainsCardView({
  claims,
  domain,
  errorMessage,
  isCreating,
  isLoading,
  isMutating,
  isRetrying,
  onCheckStatus,
  onClaim,
  onDomainChange,
  onRemove,
  onRetryLoad,
  onVerify,
  confirm,
}: VerifiedDomainsCardViewProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedDomain = domain.trim();
    if (normalizedDomain) onClaim(normalizedDomain);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Globe2 className="mr-2 inline size-5" aria-hidden="true" />
          Verified Domains
        </CardTitle>
        <CardDescription>
          Matching users automatically join as ordinary members. They keep access to their personal
          account and other organizations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Verified domains unavailable</AlertTitle>
            <AlertDescription>
              <p>{errorMessage}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryLoad}
                disabled={isMutating || isRetrying}
              >
                <RefreshCw className={isRetrying ? 'animate-spin' : undefined} aria-hidden="true" />
                {isRetrying ? 'Trying again...' : 'Try again'}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading verified domains...
          </div>
        ) : claims.length > 0 ? (
          <ul className="space-y-2" aria-label="Domain claims">
            {claims.map(claim => (
              <li
                key={claim.id}
                className="border-border bg-surface-inset flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {claim.status === 'verified' ? (
                    <CheckCircle2
                      className="text-status-success-icon size-4 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <Clock3 className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                  )}
                  <code className="min-w-0 break-all font-mono text-sm">{claim.domain}</code>
                  <Badge variant={claim.status === 'verified' ? 'new' : 'secondary'}>
                    {claim.status === 'verified' ? 'Verified' : 'Pending'}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {claim.status === 'pending' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-0"
                      onClick={() => onVerify(claim.domain)}
                      disabled={isMutating}
                      aria-label={`Verify ${claim.domain} in a new tab`}
                    >
                      <ExternalLink aria-hidden="true" />
                      Open verification
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 sm:min-h-0"
                    onClick={() => onCheckStatus(claim.id)}
                    disabled={isMutating}
                  >
                    <RefreshCw aria-hidden="true" />
                    Check status
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
                    aria-label={`Remove ${claim.domain}`}
                    onClick={() => void confirmVerifiedDomainRemoval(confirm, claim, onRemove)}
                    disabled={isMutating}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : !errorMessage ? (
          <p className="text-muted-foreground text-sm">
            No verified domains yet. Add a company email domain to start verification.
          </p>
        ) : null}

        <form className="space-y-2" onSubmit={handleSubmit}>
          <label htmlFor="verified-domain" className="text-sm font-medium">
            Company email domain
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              id="verified-domain"
              name="domain"
              value={domain}
              onChange={event => onDomainChange(event.target.value)}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
              required
              disabled={isLoading || isMutating}
              className="min-h-11 font-mono sm:min-h-0"
            />
            <Button
              type="submit"
              disabled={isLoading || isMutating || domain.trim().length === 0}
              className="min-h-11 sm:min-h-0 sm:shrink-0"
            >
              {isCreating ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {isCreating ? 'Opening verification...' : 'Claim and verify'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function VerifiedDomainsCardContent({ organizationId }: { organizationId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [domain, setDomain] = useState('');
  const verificationPortal = useRef<Window | null>(null);
  const verificationRequestPending = useRef(false);
  const mounted = useRef(true);
  const listOptions = trpc.organizations.verifiedDomains.list.queryOptions({ organizationId });
  const claimsQuery = useQuery(listOptions);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      closeVerificationPortal(verificationPortal.current);
      verificationPortal.current = null;
      verificationRequestPending.current = false;
    };
  }, []);

  const invalidateClaims = () =>
    queryClient.invalidateQueries({
      queryKey: trpc.organizations.verifiedDomains.list.queryKey({ organizationId }),
    });

  const createClaim = useMutation(
    trpc.organizations.verifiedDomains.create.mutationOptions({
      onSuccess: async data => {
        try {
          if (mounted.current) {
            showVerificationPortal(verificationPortal.current, data.verificationLink);
          }
        } finally {
          verificationPortal.current = null;
          verificationRequestPending.current = false;
        }
        if (!mounted.current) return;
        toast.success('Domain verification ready.', {
          description: 'If WorkOS did not open, use Open verification on the pending domain.',
        });
        await invalidateClaims();
      },
      onError: error => {
        closeVerificationPortal(verificationPortal.current);
        verificationPortal.current = null;
        verificationRequestPending.current = false;
        if (!mounted.current) return;
        toast.error(error.message || 'Failed to start domain verification');
      },
    })
  );
  const refreshClaim = useMutation(
    trpc.organizations.verifiedDomains.refresh.mutationOptions({
      onSuccess: async claim => {
        toast.success(
          claim.status === 'verified' ? 'Domain verified.' : 'Domain is still pending.'
        );
        await invalidateClaims();
      },
      onError: error => toast.error(error.message || 'Failed to check domain status'),
    })
  );
  const removeClaim = useMutation(
    trpc.organizations.verifiedDomains.remove.mutationOptions({
      onSuccess: async () => {
        toast.success('Domain removed.');
        await invalidateClaims();
      },
      onError: error => toast.error(error.message || 'Failed to remove domain'),
    })
  );
  const isMutating = createClaim.isPending || refreshClaim.isPending || removeClaim.isPending;
  const startVerification = (inputDomain: string, clearDraft: boolean) => {
    if (verificationRequestPending.current) return;
    verificationRequestPending.current = true;
    verificationPortal.current = reserveVerificationPortal();
    createClaim.mutate(
      { organizationId, domain: inputDomain },
      clearDraft ? { onSuccess: () => setDomain('') } : undefined
    );
  };

  return (
    <VerifiedDomainsCardView
      claims={claimsQuery.data ?? []}
      domain={domain}
      errorMessage={claimsQuery.error?.message}
      isCreating={createClaim.isPending}
      isLoading={claimsQuery.isLoading}
      isMutating={isMutating}
      isRetrying={claimsQuery.isFetching && !claimsQuery.isLoading}
      onCheckStatus={claimId => refreshClaim.mutate({ organizationId, claimId })}
      onClaim={inputDomain => startVerification(inputDomain, true)}
      onDomainChange={setDomain}
      onRemove={claimId => removeClaim.mutate({ organizationId, claimId })}
      onRetryLoad={() => void claimsQuery.refetch()}
      onVerify={inputDomain => startVerification(inputDomain, false)}
      confirm={confirm}
    />
  );
}

export function VerifiedDomainsCard({
  organizationId,
  role,
  isKiloAdmin = false,
}: {
  organizationId: string;
  role: OrganizationRole;
  isKiloAdmin?: boolean;
}) {
  if (!canViewVerifiedDomainsCard(role, isKiloAdmin)) return null;
  return <VerifiedDomainsCardContent organizationId={organizationId} />;
}
