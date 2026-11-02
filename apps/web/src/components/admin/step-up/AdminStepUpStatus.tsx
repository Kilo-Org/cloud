'use client';

import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTRPC } from '@/lib/trpc/utils';
import { useStepUp } from './StepUpProvider';
import { formatStepUpRemaining } from './step-up-error';

/**
 * Compact admin shell status for observe-mode step-up. It is informative only:
 * PR2 never denies an admin action because of this state.
 */
export function AdminStepUpStatus() {
  const trpc = useTRPC();
  const { requestStepUp } = useStepUp();
  const statusQuery = useQuery({
    ...trpc.stepUp.getStatus.queryOptions(),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const revoke = useMutation(
    trpc.stepUp.revokeCurrent.mutationOptions({
      onSuccess: () => statusQuery.refetch(),
    })
  );

  const status = statusQuery.data;
  if (!status) return null;

  if (status.fresh && status.status.status === 'fresh') {
    return (
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2 text-sm">
        <ShieldCheck className="size-4 text-emerald-600" aria-hidden="true" />
        <span className="font-medium">MFA verified</span>
        <span className="text-muted-foreground">
          {formatStepUpRemaining(status.status.expiresAt)}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => revoke.mutate(undefined)}
          disabled={revoke.isPending}
        >
          {revoke.isPending ? 'Locking...' : 'Lock now'}
        </Button>
      </div>
    );
  }

  if (!status.sessionBound) {
    return (
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2 text-sm">
        <ShieldAlert className="size-4 text-amber-600" aria-hidden="true" />
        <span className="font-medium">MFA needs a fresh sign-in</span>
        <span className="text-muted-foreground">
          This session predates session-bound verification.
        </span>
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link href="/users/sign_in">Sign in again</Link>
        </Button>
      </div>
    );
  }

  if (!status.enrolled) {
    return (
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2 text-sm">
        <ShieldAlert className="size-4 text-amber-600" aria-hidden="true" />
        <span className="font-medium">No passkey enrolled</span>
        <span className="text-muted-foreground">Add a passkey to verify admin actions.</span>
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link href="/connected-accounts">Set up a passkey</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b bg-card px-4 py-2 text-sm">
      <ShieldAlert className="size-4 text-amber-600" aria-hidden="true" />
      <span className="font-medium">MFA not verified</span>
      <span className="text-muted-foreground">
        {status.mode === 'observe'
          ? 'Verification is being measured but is not required yet.'
          : 'Verify before sensitive admin actions.'}
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={() => void requestStepUp()}>
        Verify now
      </Button>
    </div>
  );
}
