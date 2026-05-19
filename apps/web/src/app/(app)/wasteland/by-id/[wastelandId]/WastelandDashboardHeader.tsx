'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { WastelandBetaBadge } from '@/components/wasteland/WastelandBetaBadge';
import { SyncForkButton } from '@/components/wasteland/SyncForkButton';
import { Skeleton } from '@/components/ui/skeleton';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Skull } from 'lucide-react';
import { useWastelandPageHeader } from './WastelandPageHeaderContext';

export function WastelandDashboardHeader() {
  const params = useParams<{ wastelandId: string }>();
  const wastelandId = params.wastelandId;
  const trpc = useWastelandTRPC();

  const wastelandQuery = useQuery(trpc.wasteland.getWasteland.queryOptions({ wastelandId }));
  const wasteland = wastelandQuery.data;
  // Page-specific section contributed by the active route via
  // `useSetWastelandPageHeader`. May be null during loading or if a page
  // hasn't written one (e.g. placeholder routes).
  const pageHeader = useWastelandPageHeader();

  return (
    <div className="border-b border-white/[0.06]">
      <div className="flex items-center gap-3 px-4 py-3">
        <SidebarTrigger className="-ml-1" />

        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color:oklch(70%_0.15_30_/_0.15)] ring-1 ring-[color:oklch(70%_0.15_30_/_0.25)]">
          <Skull className="size-4 text-[color:oklch(70%_0.15_30)]" />
        </div>

        {wastelandQuery.isLoading ? (
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-16" />
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight text-white/90">
              {wasteland?.name ?? 'Wasteland'}
            </h1>
            <WastelandBetaBadge />
          </div>
        )}

        {/* Page-specific section — title + count + CTAs. Takes available
            width so its inline actions stay left-of the persistent CTAs. */}
        {pageHeader && (
          <div className="flex flex-1 items-center justify-between gap-2 pl-3">
            <div className="flex items-center gap-2">
              {pageHeader.icon}
              <h2 className="text-lg font-semibold tracking-tight text-white/90">
                {pageHeader.title}
              </h2>
              {pageHeader.count != null && (
                <span className="ml-1 font-mono text-xs text-white/30">{pageHeader.count}</span>
              )}
            </div>
            {pageHeader.actions && (
              <div className="flex items-center gap-2">{pageHeader.actions}</div>
            )}
          </div>
        )}

        {/* Persistent CTAs that apply to every wasteland sub-page.
            When no page header is mounted, push these to the right. */}
        <div className={pageHeader ? 'flex items-center gap-2' : 'ml-auto flex items-center gap-2'}>
          <SyncForkButton wastelandId={wastelandId} />
        </div>
      </div>
    </div>
  );
}
