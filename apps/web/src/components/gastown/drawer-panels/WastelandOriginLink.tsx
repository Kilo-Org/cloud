'use client';

import { Compass, ExternalLink } from 'lucide-react';
import {
  buildWastelandItemHref,
  readWastelandBeadOrigin,
} from '@/components/gastown/wasteland-bead-origin';

/**
 * Renders inside the BeadPanel between the PR-link block and the
 * Related-Beads DAG. Shows nothing when the bead's metadata is absent or
 * doesn't carry a `wasteland` origin tag.
 *
 * The link routes to the wanted board with `?itemId=...`, which the
 * WantedBoardClient picks up to auto-open the wanted-item drawer.
 */
export function WastelandOriginLink({
  metadata,
  pathname,
}: {
  metadata: Record<string, unknown>;
  pathname: string | null;
}) {
  const origin = readWastelandBeadOrigin(metadata);
  if (!origin) return null;

  const href = buildWastelandItemHref(origin, pathname);

  return (
    <div className="border-b border-white/[0.06] px-5 py-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Compass className="size-3 text-white/25" />
        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
          Wasteland Item
        </span>
      </div>
      <a
        href={href}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-[color:oklch(95%_0.15_108)] transition-colors hover:bg-white/[0.06]"
      >
        <ExternalLink className="size-3" />
        <span className="font-mono">{origin.item_id}</span>
      </a>
    </div>
  );
}
