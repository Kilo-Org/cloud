'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { DrawerStackHelpers } from '@/components/drawer';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { WantedItemPanel } from './WantedItemPanel';
import type { WantedItemTab, WastelandDrawerRef } from './types';

/**
 * Fetches a wanted item by id and defers to WantedItemPanel once loaded.
 * Used for cross-reference navigation from drawers where only the id is
 * known (e.g. clicking a wanted id inside a Review PR drawer) — we don't
 * have the full row in scope so we re-fetch on mount.
 */
export function WantedItemByIdPanel({
  wastelandId,
  itemId,
  push,
  initialTab,
}: {
  wastelandId: string;
  itemId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
  initialTab?: WantedItemTab;
}) {
  const trpc = useWastelandTRPC();
  const query = useQuery(trpc.wasteland.getWantedItem.queryOptions({ wastelandId, itemId }));

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-white/40">
        <Loader2 className="size-3.5 animate-spin" />
        <span className="text-xs">Loading {itemId}…</span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-4">
        <p className="text-sm text-red-400">Failed to load wanted item</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">{query.error.message}</p>
      </div>
    );
  }

  if (!query.data) {
    return (
      <div className="p-4">
        <p className="text-sm text-white/70">Wanted item not found</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">itemId: {itemId}</p>
        <p className="mt-3 text-[11px] text-white/40">
          The item may have been deleted from upstream, or it was created on a branch that
          hasn&apos;t merged yet.
        </p>
      </div>
    );
  }

  return (
    <WantedItemPanel
      wastelandId={wastelandId}
      item={query.data}
      actions={null}
      push={push}
      initialTab={initialTab}
    />
  );
}
