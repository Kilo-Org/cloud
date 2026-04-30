'use client';

import { Rocket, Info, AlertTriangle } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';
import { Switch } from '@/components/ui/switch';

/**
 * User self serve toggle for the per user `kiloclaw_early_access` flag.
 * When on, the rollout selector force includes the user's instances in any
 * in flight candidate, regardless of bucket. Per instance pins still win,
 * so the toggle is purely additive: it never overrides a pin.
 *
 * Sits inside the "Manage Version" expandable on the consumer settings page,
 * alongside VersionPinCard.
 */
export function EarlyAccessCard() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const {
    data: enabled,
    isLoading,
    isError,
  } = useQuery(trpc.kiloclaw.myEarlyAccess.queryOptions());

  const { mutateAsync, isPending } = useMutation(
    trpc.kiloclaw.setMyEarlyAccess.mutationOptions({
      onSuccess: result => {
        toast.success(result.earlyAccess ? 'Early Access enabled' : 'Early Access disabled');
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.myEarlyAccess.queryKey(),
        });
        // Refresh both personal and org latest-version queries — this card
        // renders on both Settings pages and the toggle affects whichever
        // instance the user is looking at.
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.latestVersion.queryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.organizations.kiloclaw.latestVersion.queryKey(),
        });
      },
      onError: err => {
        toast.error(`Failed to update Early Access: ${err.message}`);
      },
    })
  );

  return (
    <div>
      <h3 className="text-foreground mb-1 flex items-center gap-2 text-sm font-medium">
        <Rocket className="size-4" />
        Early Access
      </h3>
      <div className="grid grid-cols-1 items-start gap-6 sm:grid-cols-2">
        {/* Left: description */}
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">
            Get new versions before everyone else. When a release is rolling out, your instances see
            it right away instead of waiting for full availability.
          </p>
          <div className="flex items-start gap-1 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Heads up: early versions are still being tested. They may have bugs or rough edges
              that the general release won&apos;t. Leave this off if you want the most stable
              experience.
            </span>
          </div>
          <div className="text-muted-foreground flex items-start gap-1 text-xs">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              Applies to all of your instances, personal and org. A version pin always wins per
              instance, so a pinned instance ignores Early Access until you unpin.
            </span>
          </div>
        </div>

        {/* Right: toggle + inline status label. Vertically centers in the
            column so it lines up against the start of the description. */}
        <div className="flex items-center gap-3 pt-0.5">
          <Switch
            checked={!!enabled}
            disabled={isLoading || isPending || isError}
            onCheckedChange={next => {
              void mutateAsync({ value: next });
            }}
            aria-label="Early Access"
          />
          <span className="text-sm">
            {isError ? (
              <span className="text-destructive">Failed to load</span>
            ) : isLoading || isPending ? (
              <span className="text-muted-foreground">…</span>
            ) : enabled ? (
              <span className="font-medium text-green-500">Enabled</span>
            ) : (
              <span className="text-muted-foreground">Disabled</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
