'use client';

/**
 * Small inline components for clickable cross-references inside drawer panels.
 * Each wraps its content in a button that pushes a new drawer onto the stack,
 * giving the cyclic graph of wasteland data a consistent interaction pattern:
 * rig handle → rig drawer, wanted item id → wanted drawer, etc.
 *
 * The visual idiom matches gastown's Pattern A metadata cells: mono text for
 * identifiers, a subtle underline on hover, and no heavy chrome so lists
 * stay dense.
 */

import type { DrawerStackHelpers } from '@/components/drawer';
import type { WastelandDrawerRef } from './types';
import { ChevronRight, Truck, ScrollText } from 'lucide-react';

export function RigLink({
  handle,
  wastelandId,
  push,
  variant = 'inline',
}: {
  handle: string;
  wastelandId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
  variant?: 'inline' | 'row';
}) {
  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={() => push({ type: 'rig', wastelandId, handle })}
        className="group/link flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
      >
        <Truck className="size-3.5 shrink-0 text-white/30" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-white/75">{handle}</span>
        <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/link:text-white/25" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => push({ type: 'rig', wastelandId, handle })}
      className="inline-flex items-center gap-1 font-mono text-xs text-white/75 underline decoration-white/20 decoration-dotted underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
    >
      {handle}
    </button>
  );
}

export function WantedItemLink({
  itemId,
  wastelandId,
  push,
  label,
  variant = 'inline',
}: {
  itemId: string;
  wastelandId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
  /** Human-readable title to show instead of the raw id when `variant='row'`. */
  label?: string | null;
  variant?: 'inline' | 'row' | 'mono';
}) {
  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={() => push({ type: 'wanted-item-by-id', wastelandId, itemId })}
        className="group/link flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
      >
        <ScrollText className="size-3.5 shrink-0 text-white/30" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs text-white/75">{label ?? itemId}</div>
          {label && <div className="truncate font-mono text-[10px] text-white/30">{itemId}</div>}
        </div>
        <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/link:text-white/25" />
      </button>
    );
  }
  if (variant === 'mono') {
    return (
      <button
        type="button"
        onClick={() => push({ type: 'wanted-item-by-id', wastelandId, itemId })}
        className="font-mono text-[10px] text-white/30 underline decoration-white/10 decoration-dotted underline-offset-2 transition-colors hover:text-white/70 hover:decoration-white/40"
      >
        {itemId}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => push({ type: 'wanted-item-by-id', wastelandId, itemId })}
      className="inline-flex items-center gap-1 text-xs text-white/75 underline decoration-white/20 decoration-dotted underline-offset-2 transition-colors hover:text-white hover:decoration-white/60"
    >
      {label ?? itemId}
    </button>
  );
}
