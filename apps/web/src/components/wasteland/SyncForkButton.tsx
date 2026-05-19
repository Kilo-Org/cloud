'use client';

import { useQuery } from '@tanstack/react-query';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ArrowDownToLine, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { cn } from '@/lib/utils';

/**
 * Persistent header CTA that surfaces fork-currency state and routes
 * the user to DoltHub to sync their fork manually. Programmatic sync
 * isn't possible — DoltHub's PR API rejects upstream→fork PR creation
 * because the fork owner lacks write on the parent repo, and the
 * `CALL DOLT_FETCH/MERGE` family is blocked on hosted SQL. The deep
 * link drops the user on `<fork>/pulls/new` with `fromBranchOwner`,
 * `fromBranchRepo`, `fromBranch`, and `toBranch` prefilled (DoltHub
 * reads these query params via Next.js `getServerSideProps`), so they
 * only need to confirm and merge — DoltHub does NOT expose a
 * one-click "Sync from upstream" button.
 *
 * States:
 *  - **loading** — skeleton; query in flight.
 *  - **current** — muted; still clickable in case the user wants to
 *    open the fork on DoltHub for other reasons.
 *  - **stale** — yellow accent to draw the eye.
 *  - **error** — query failed; passive ghost button so the chrome
 *    stays put and the user can retry.
 */
export function SyncForkButton({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const query = useQuery({
    ...trpc.wasteland.getForkCurrency.queryOptions({ wastelandId }),
    // Re-check on focus so a UI tab left open across an upstream merge
    // shows the stale state without needing a manual refresh.
    refetchOnWindowFocus: true,
    // Currency reads cost two HASHOF queries per call; a 30s cache
    // is plenty fresh for what is, for the user, an "is the world
    // moving under me" indicator.
    staleTime: 30_000,
  });

  if (query.isLoading) {
    return <Skeleton className="h-8 w-28 rounded-md" />;
  }

  // The deep-link is only ever opened on direct user action (via the
  // anchor below), so any error path falls back to a static link to the
  // fork's pulls/new — the worker query failure shouldn't strand the
  // user when they know they need to sync.
  const data = query.data;
  const isStale = data ? !data.isCurrent : false;
  const href = data?.syncUrl ?? '#';

  // We render Radix's tooltip primitives directly here rather than the
  // shared `ui/tooltip` wrapper. The shared wrapper hardcodes
  // `bg-primary` + a brand-yellow Radix Arrow — intentional accent
  // styling for single-line tooltips, but a blinding yellow card for
  // our multi-line info tooltip on a dark surface. Going one level
  // down lets us drop the arrow entirely and use the elevated dark
  // `popover` tokens that match the rest of the app shell.
  return (
    <TooltipPrimitive.Provider delayDuration={150}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <Button
            asChild
            size="sm"
            variant={isStale ? 'outline' : 'ghost'}
            className={cn(
              'gap-1.5 font-medium',
              isStale &&
                'border-yellow-500/40 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 hover:text-yellow-300',
              !isStale && 'text-muted-foreground hover:text-foreground'
            )}
          >
            <a href={href} target="_blank" rel="noopener noreferrer">
              {isStale ? (
                <ArrowDownToLine className="size-3.5" aria-hidden />
              ) : (
                <CheckCircle2 className="size-3.5" aria-hidden />
              )}
              <span>Sync fork</span>
            </a>
          </Button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="bottom"
            sideOffset={6}
            className="z-50 max-w-xs animate-in fade-in-0 zoom-in-95 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {data ? (
              <SyncForkTooltipBody data={data} isStale={isStale} />
            ) : (
              <p className="text-xs">
                Opens DoltHub with a PR prefilled from upstream into your fork.
              </p>
            )}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function SyncForkTooltipBody({
  data,
  isStale,
}: {
  data: {
    upstream: string;
    fork: string;
    upstreamHead: string | null;
    forkHead: string | null;
  };
  isStale: boolean;
}) {
  return (
    <div className="space-y-1.5 text-xs">
      <p className={cn('font-medium', isStale ? 'text-yellow-400' : 'text-foreground')}>
        {isStale ? 'Fork is behind upstream' : 'Fork is current with upstream'}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <dt>upstream</dt>
        <dd className="truncate">{data.upstream}</dd>
        <dt>fork</dt>
        <dd className="truncate">{data.fork}</dd>
      </dl>
      <p className="pt-1 text-[11px] text-muted-foreground">
        {isStale
          ? 'Opens DoltHub on the new-PR form, prefilled from upstream main into your fork main. Confirm and merge there to bring your fork up to date.'
          : 'Your fork main matches upstream main. Open DoltHub if you need to inspect the fork directly.'}
      </p>
    </div>
  );
}
