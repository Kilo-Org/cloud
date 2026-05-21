'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  Hand,
  Loader2,
  ScrollText,
  ShieldCheck,
  Star,
  StarOff,
  Truck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import type { DrawerStackHelpers } from '@/components/drawer';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { parseDoltDate } from '@/lib/wasteland/date';
import type { WastelandDrawerRef, RigActivity } from './types';
import { WantedItemLink } from './CrossRefs';

/**
 * Rig detail drawer — shows the rig's registration metadata, trust level,
 * and all cross-referenced activity (items posted, items claimed,
 * completions, stamps authored, stamps received, open upstream PRs).
 * Each activity row is itself a link that pushes the relevant drawer onto
 * the stack so the admin can walk the data graph.
 */
export function RigPanel({
  wastelandId,
  handle,
  push,
}: {
  wastelandId: string;
  handle: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();

  const rigQuery = useQuery(trpc.wasteland.getRig.queryOptions({ wastelandId, handle }));
  const activityQuery = useQuery(
    trpc.wasteland.listRigActivity.queryOptions({ wastelandId, handle })
  );
  // listInboxItems is the canonical open-PR list. Filter client-side by
  // submitter === handle instead of refetching — the Review page already
  // loaded this query when the user was browsing PRs, so it's typically
  // cached and returns instantly here.
  const inboxQuery = useQuery(trpc.wasteland.listInboxItems.queryOptions({ wastelandId }));
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const isUpstreamAdmin = credentialQuery.data?.is_upstream_admin ?? false;

  const setTrust = useMutation({
    ...trpc.wasteland.setUpstreamRigTrust.mutationOptions(),
    onSuccess: () => {
      toast.success('Trust level updated');
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.getRig.queryKey({ wastelandId, handle }),
      });
      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listUpstreamRigs.queryKey({ wastelandId }),
      });
    },
    onError: err => toast.error(`Failed to update trust: ${err.message}`),
  });

  if (rigQuery.isLoading) {
    return <LoadingState label={`Loading rig ${handle}…`} />;
  }

  if (rigQuery.isError) {
    return (
      <div className="p-4">
        <p className="text-sm text-red-400">Failed to load rig</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">{rigQuery.error.message}</p>
      </div>
    );
  }

  const rig = rigQuery.data;
  if (!rig) {
    return (
      <div className="p-4">
        <p className="text-sm text-white/70">Rig not found</p>
        <p className="mt-1 font-mono text-[11px] text-white/40">handle: {handle}</p>
        <p className="mt-3 text-[11px] text-white/40">
          The rig may exist in commit history but is no longer in the upstream <code>rigs</code>{' '}
          table.
        </p>
      </div>
    );
  }

  const activity = activityQuery.data;
  const openPRs = (inboxQuery.data?.items ?? []).filter(p => p.submitter === handle);

  return (
    <div className="space-y-0 pb-4">
      {/* Header */}
      <div className="border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
            <Truck className="size-5 text-emerald-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-mono text-base text-white/90">{rig.rig_handle}</h3>
            {rig.display_name && (
              <p className="mt-0.5 truncate text-sm text-white/60">{rig.display_name}</p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-2">
              <TrustBadge level={rig.trust_level} />
              {rig.gt_version && (
                <Badge variant="outline" className="border-white/[0.08] text-[10px] text-white/50">
                  wl {rig.gt_version}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {isUpstreamAdmin && (
          <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-3">
            <ShieldCheck className="size-3 text-amber-400/70" />
            <label className="text-[10px] font-medium tracking-wide text-white/40 uppercase">
              Set trust level
            </label>
            <select
              value={rig.trust_level}
              disabled={setTrust.isPending}
              onChange={e =>
                setTrust.mutate({
                  wastelandId,
                  rigHandle: rig.rig_handle,
                  trustLevel: Number(e.target.value),
                })
              }
              className="ml-auto rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-xs text-white/80 outline-none focus:border-white/20 disabled:opacity-50"
            >
              {[0, 1, 2, 3].map(level => (
                <option key={level} value={level}>
                  Trust {level}
                </option>
              ))}
            </select>
            {setTrust.isPending && <Loader2 className="size-3 animate-spin text-white/40" />}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 border-b border-white/[0.06]">
        {rig.dolthub_org && (
          <MetaCell
            label="DoltHub org"
            value={
              <a
                href={`https://www.dolthub.com/profile/${encodeURIComponent(rig.dolthub_org)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-white/75 hover:text-sky-400"
              >
                {rig.dolthub_org}
                <ExternalLink className="size-3" />
              </a>
            }
          />
        )}
        {rig.owner_email && (
          <MetaCell label="Owner" value={<span className="font-mono">{rig.owner_email}</span>} />
        )}
        {rig.hop_uri && (
          <MetaCell
            label="Hop URI"
            value={<span className="font-mono text-[10px] break-all">{rig.hop_uri}</span>}
            fullWidth
          />
        )}
        <MetaCell label="Registered" value={formatRelative(rig.registered_at)} />
        <MetaCell label="Last seen" value={formatRelative(rig.last_seen_at)} />
      </div>

      {/* Activity sections */}
      {activityQuery.isLoading ? (
        <LoadingState label="Loading activity…" />
      ) : activityQuery.isError ? (
        <div className="px-5 py-4">
          <p className="text-sm text-red-400">Failed to load activity</p>
          <p className="mt-1 font-mono text-[11px] text-white/40">{activityQuery.error.message}</p>
        </div>
      ) : (
        <>
          {openPRs.length > 0 && (
            <ActivitySection icon={GitPullRequest} title="Open PRs" count={openPRs.length}>
              <div className="flex flex-col gap-0.5">
                {openPRs.map(pr => (
                  <button
                    key={pr.pull_id}
                    type="button"
                    onClick={() =>
                      push({
                        type: 'review-item',
                        wastelandId,
                        item: pr,
                        actions: null,
                      })
                    }
                    className="group/link flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <GitPullRequest className="size-3.5 shrink-0 text-white/30" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs text-white/75">{pr.title}</span>
                        <Badge
                          variant="outline"
                          className="border-white/[0.08] font-mono text-[10px] text-white/40"
                        >
                          #{pr.pull_id}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-white/30">
                        {prKindLabel(pr.kind)}
                      </div>
                    </div>
                    <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/link:text-white/25" />
                  </button>
                ))}
              </div>
            </ActivitySection>
          )}

          <WantedList
            title="Posted"
            icon={ScrollText}
            items={activity?.posted ?? []}
            wastelandId={wastelandId}
            push={push}
          />
          <WantedList
            title="Claimed"
            icon={Hand}
            items={activity?.claimed ?? []}
            wastelandId={wastelandId}
            push={push}
          />
          <CompletionList activity={activity} wastelandId={wastelandId} push={push} />
          <StampList
            title="Stamps authored"
            icon={Star}
            stamps={activity?.stamps_authored ?? []}
            wastelandId={wastelandId}
            push={push}
          />
          <StampList
            title="Stamps received"
            icon={StarOff}
            stamps={activity?.stamps_received ?? []}
            wastelandId={wastelandId}
            push={push}
          />

          {isActivityEmpty(activity, openPRs.length) && (
            <div className="px-5 py-8 text-center">
              <p className="text-xs text-white/30">No activity yet on this wasteland.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────

function ActivitySection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: typeof ScrollText;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  if (count === 0) return null;
  return (
    <div className="border-b border-white/[0.06] px-3 py-3">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/[0.03]"
      >
        <Icon className="size-3 text-white/25" />
        <span className="text-[10px] font-medium tracking-wide text-white/30 uppercase">
          {title}
        </span>
        <span className="text-[10px] text-white/20">· {count}</span>
        <motion.div
          animate={{ rotate: expanded ? 0 : 90 }}
          transition={{ duration: 0.18, ease: 'easeInOut' }}
          className="ml-auto"
        >
          <ChevronRight className="size-3 text-white/25" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function WantedList({
  title,
  icon,
  items,
  wastelandId,
  push,
}: {
  title: string;
  icon: typeof ScrollText;
  items: RigActivity['posted'];
  wastelandId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  if (items.length === 0) return null;
  return (
    <ActivitySection icon={icon} title={title} count={items.length}>
      <div className="flex flex-col gap-0.5">
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() =>
              push({
                type: 'wanted-item',
                wastelandId,
                item,
                actions: null,
              })
            }
            className="group/link flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
          >
            <ScrollText className="size-3.5 shrink-0 text-white/30" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs text-white/75">{item.title}</span>
                <Badge variant="outline" className="border-white/[0.08] text-[9px] text-white/45">
                  {item.status}
                </Badge>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-white/30">{item.id}</div>
            </div>
            <ChevronRight className="size-3 shrink-0 text-white/10 transition-colors group-hover/link:text-white/25" />
          </button>
        ))}
      </div>
    </ActivitySection>
  );
}

function CompletionList({
  activity,
  wastelandId,
  push,
}: {
  activity: RigActivity | undefined;
  wastelandId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  const completions = activity?.completions ?? [];
  if (completions.length === 0) return null;
  return (
    <ActivitySection icon={Hand} title="Completions" count={completions.length}>
      <div className="flex flex-col gap-0.5">
        {completions.map(c => (
          <div key={c.completion_id} className="flex items-start gap-2.5 rounded-md px-3 py-2">
            <Hand className="mt-0.5 size-3.5 shrink-0 text-white/30" />
            <div className="min-w-0 flex-1">
              <WantedItemLink
                itemId={c.wanted_id}
                label={c.wanted_title}
                wastelandId={wastelandId}
                push={push}
                variant="row"
              />
              {c.evidence && (
                <a
                  href={c.evidence}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mx-3 inline-flex items-center gap-1 truncate font-mono text-[10px] text-sky-400 hover:text-sky-300"
                >
                  <ExternalLink className="size-2.5" />
                  evidence
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </ActivitySection>
  );
}

function StampList({
  title,
  icon,
  stamps,
  wastelandId,
  push,
}: {
  title: string;
  icon: typeof Star;
  stamps: RigActivity['stamps_authored'];
  wastelandId: string;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
}) {
  if (stamps.length === 0) return null;
  return (
    <ActivitySection icon={icon} title={title} count={stamps.length}>
      <div className="flex flex-col gap-0.5">
        {stamps.map(s => (
          <div key={s.stamp_id} className="flex items-start gap-2.5 rounded-md px-3 py-2">
            <Star className="mt-0.5 size-3.5 shrink-0 text-emerald-400/60" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2 text-[10px] text-white/40">
                <span className="font-mono">{s.author}</span>
                <span>→</span>
                <span className="font-mono">{s.subject}</span>
                {s.severity && (
                  <Badge variant="outline" className="border-white/[0.08] text-[9px] text-white/50">
                    {s.severity}
                  </Badge>
                )}
              </div>
              {s.wanted_id && (
                <WantedItemLink
                  itemId={s.wanted_id}
                  label={s.wanted_title}
                  wastelandId={wastelandId}
                  push={push}
                  variant="row"
                />
              )}
              {s.message && (
                <p className="mx-3 line-clamp-2 text-[11px] text-white/55">{s.message}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </ActivitySection>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function TrustBadge({ level }: { level: number }) {
  const color =
    level >= 3
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : level === 2
        ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
        : level === 1
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
          : 'border-white/[0.08] bg-white/[0.03] text-white/50';
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${color}`}
    >
      Trust {level}
    </span>
  );
}

function MetaCell({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={`flex flex-col border-r border-b border-white/[0.04] px-4 py-3 ${
        fullWidth ? 'col-span-2 border-r-0' : '[&:nth-child(2n)]:border-r-0'
      }`}
    >
      <div className="text-[10px] tracking-wide text-white/30 uppercase">{label}</div>
      <div className="mt-0.5 truncate text-sm text-white/70">{value}</div>
    </div>
  );
}

function formatRelative(iso: string | null): string {
  const d = parseDoltDate(iso);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : '—';
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-6 text-white/40">
      <Loader2 className="size-3.5 animate-spin" />
      <span className="text-xs">{label}</span>
    </div>
  );
}

function prKindLabel(kind: string): string {
  switch (kind) {
    case 'rig-registration':
      return 'Rig registration';
    case 'wanted-post':
      return 'New wanted post';
    case 'wanted-edit':
      return 'Wanted edit';
    case 'work-submission':
      return 'Work submission';
    case 'admin-action':
      return 'Admin action';
    default:
      return 'Foreign PR';
  }
}

function isActivityEmpty(activity: RigActivity | undefined, openPRCount: number): boolean {
  if (openPRCount > 0) return false;
  if (!activity) return true;
  return (
    activity.posted.length === 0 &&
    activity.claimed.length === 0 &&
    activity.completions.length === 0 &&
    activity.stamps_authored.length === 0 &&
    activity.stamps_received.length === 0
  );
}
