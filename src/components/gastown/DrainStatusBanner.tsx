'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { Banner } from '@/components/shared/Banner';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Banner displayed when the town's container is draining (graceful restart
 * in progress). Shows how long the drain has been running and provides a
 * force-shutdown button to expedite the process.
 *
 * Polls every 5s so it appears/disappears promptly.
 */
export function DrainStatusBanner({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...trpc.gastown.getDrainStatus.queryOptions({ townId }),
    refetchInterval: 5_000,
  });

  const { data: adminAccess } = useQuery(trpc.gastown.checkAdminAccess.queryOptions({ townId }));
  const isReadOnly = adminAccess?.isAdminViewing === true;

  const destroyContainer = useMutation(
    trpc.gastown.destroyContainer.mutationOptions({
      onSuccess: () => {
        toast.success('Container destroyed — it will restart on next dispatch');
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.getDrainStatus.queryKey({ townId }),
        });
      },
      onError: err => toast.error(`Force shutdown failed: ${err.message}`),
    })
  );

  if (!data?.draining) return null;

  const elapsed = data.drainStartedAt
    ? Math.round((Date.now() - new Date(data.drainStartedAt).getTime()) / 1000)
    : null;
  const elapsedLabel =
    elapsed !== null
      ? elapsed < 60
        ? `${elapsed}s ago`
        : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s ago`
      : null;

  return (
    <Banner color="amber" className="mt-4 mb-4" role="alert">
      <Banner.Icon>
        <AlertTriangle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Container restart in progress</Banner.Title>
        <Banner.Description>
          A graceful shutdown was initiated{elapsedLabel ? ` ${elapsedLabel}` : ''}. Agents are
          finishing their current work — no new tasks will be dispatched until the restart
          completes.
        </Banner.Description>
      </Banner.Content>
      {!isReadOnly && (
        <Banner.Action>
          <Button
            variant="destructive"
            size="sm"
            disabled={destroyContainer.isPending}
            onClick={() => destroyContainer.mutate({ townId })}
          >
            {destroyContainer.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Force Shutdown
          </Button>
        </Banner.Action>
      )}
    </Banner>
  );
}
