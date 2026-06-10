'use client';

import { formatDistanceToNow } from 'date-fns';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { DrawerStackHelpers } from '@/components/drawer';
import { MarkdownProse } from '@/components/security-agent/MarkdownProse';
import { parseDoltDate } from '@/lib/wasteland/date';
import type { WantedItem, WantedPanelActions, WantedPanelLinks, WastelandDrawerRef } from './types';
import { RigLink } from './CrossRefs';
import { ClaimAction } from './WantedItemBranchTab';

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  claimed: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  in_review: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  completed: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  done: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  withdrawn: 'bg-white/[0.04] text-white/40 border-white/10',
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-white/55',
  medium: 'text-sky-300',
  high: 'text-amber-300',
  critical: 'text-red-300',
};

const TYPE_COLORS: Record<string, string> = {
  feature: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  bug: 'bg-red-500/10 text-red-400 border-red-500/20',
  docs: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  other: 'bg-white/[0.04] text-white/40 border-white/10',
};

/**
 * Read-only upstream view — what `<owner>/<repo>` on `main` says about
 * this item right now. Renders the canonical title, description,
 * status, posted_by/claimed_by, and metadata. No mutation buttons live
 * here; branch-side actions live in the `My branch` tab.
 */
export function WantedItemUpstreamTab({
  wastelandId,
  item,
  actions,
  links,
  push,
}: {
  wastelandId: string;
  item: WantedItem;
  actions: WantedPanelActions | null;
  links?: WantedPanelLinks;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  return (
    <div className="space-y-4">
      <p className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
        Upstream snapshot
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={STATUS_COLORS[item.status] ?? ''}>
          {item.status}
        </Badge>
        <Badge variant="outline" className={TYPE_COLORS[item.type ?? 'other'] ?? TYPE_COLORS.other}>
          {item.type ?? 'other'}
        </Badge>
        <span
          className={`text-xs font-medium ${
            PRIORITY_COLORS[String(item.priority ?? 'medium')] ?? 'text-white/40'
          }`}
        >
          {item.priority ?? 'medium'} priority
        </span>
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
          Description
        </label>
        {item.description ? (
          <MarkdownProse markdown={item.description} className="text-sm text-white/70" />
        ) : (
          <p className="text-sm text-white/40 italic">No description provided.</p>
        )}
      </div>

      {item.posted_by && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Posted by
          </label>
          <RigLink handle={item.posted_by} wastelandId={wastelandId} push={push} />
        </div>
      )}

      {item.claimed_by && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Claimed by
          </label>
          <RigLink handle={item.claimed_by} wastelandId={wastelandId} push={push} />
        </div>
      )}

      {item.evidence_url && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Evidence
          </label>
          <a
            href={item.evidence_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-400 underline underline-offset-2 hover:text-sky-300"
          >
            {item.evidence_url}
          </a>
        </div>
      )}

      <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
        <DetailRow label="Created" value={formatTimestamp(item.created_at)} />
        <DetailRow label="Updated" value={formatTimestamp(item.updated_at)} />
      </div>

      <div className="border-t border-white/[0.06] pt-3">
        <DetailRow label="Item ID" value={item.id} mono />
      </div>

      {links?.workshopHref && item.status === 'open' && (
        <div className="border-t border-white/[0.06] pt-3">
          <Button asChild size="sm" className="h-8 gap-1.5">
            <Link href={links.workshopHref}>
              Take to my workshop
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
          <p className="mt-1.5 text-[11px] text-white/40">
            Opens your fork workspace for this item. Claim and evidence actions live there.
          </p>
        </div>
      )}

      {actions && item.status === 'open' && !links?.workshopHref && (
        <div className="border-t border-white/[0.06] pt-3">
          <p className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Workshop action
          </p>
          <ClaimAction wastelandId={wastelandId} item={item} />
          <p className="mt-1.5 text-[11px] text-white/40">
            Claiming creates your branch and submits the claim upstream for review.
          </p>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-white/30">{label}</span>
      <span className={`text-white/60 ${mono ? 'font-mono text-[10px]' : ''}`}>{value}</span>
    </div>
  );
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = parseDoltDate(iso);
  if (!d) return iso;
  try {
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return iso;
  }
}
