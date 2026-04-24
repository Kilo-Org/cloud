'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import type { WastelandOutputs } from '@/lib/wasteland/trpc';
import { parseDoltDate } from '@/lib/wasteland/date';
import { useUser } from '@/hooks/useUser';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Truck, Loader2, ShieldCheck, ChevronRight, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';

type TrustFilter = number | null;
type Rig = WastelandOutputs['wasteland']['listUpstreamRigs']['rigs'][number];

// Stable empty-array reference so memos that depend on the fallback
// don't re-run on every loading-state render.
const EMPTY_RIGS: Rig[] = [];

export function RigsClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const { open: openDrawer } = useDrawerStack();

  const [search, setSearch] = useState('');
  const [trustFilter, setTrustFilter] = useState<TrustFilter>(null);

  const wastelandQuery = useQuery(trpc.wasteland.getWasteland.queryOptions({ wastelandId }));
  const credentialQuery = useQuery(
    trpc.wasteland.getCredentialStatus.queryOptions({ wastelandId })
  );
  const membersQuery = useQuery(trpc.wasteland.listMembers.queryOptions({ wastelandId }));

  const isUpstreamAdmin = credentialQuery.data?.is_upstream_admin === true;
  const currentUserMember = membersQuery.data?.find(m => m.user_id === currentUser?.id);
  const isOwner = currentUserMember?.role === 'owner' || currentUser?.is_admin === true;

  const rigsQueryKey = trpc.wasteland.listUpstreamRigs.queryKey({ wastelandId });
  // Only fetch when the caller is a wasteland owner — the endpoint enforces
  // this server-side and returns FORBIDDEN otherwise.
  const rigsQuery = useQuery({
    ...trpc.wasteland.listUpstreamRigs.queryOptions({ wastelandId }),
    enabled: isOwner,
  });

  const setTrust = useMutation({
    ...trpc.wasteland.setUpstreamRigTrust.mutationOptions(),
    onSuccess: () => {
      toast.success('Trust level updated');
      void queryClient.invalidateQueries({ queryKey: rigsQueryKey });
    },
    onError: err => toast.error(`Failed to update trust: ${err.message}`),
  });

  const rigs = rigsQuery.data?.rigs ?? EMPTY_RIGS;

  const trustCounts = useMemo(() => {
    const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const rig of rigs) {
      counts[rig.trust_level] = (counts[rig.trust_level] ?? 0) + 1;
    }
    return counts;
  }, [rigs]);

  const filteredRigs = useMemo(() => {
    let result = rigs;
    if (trustFilter !== null) {
      result = result.filter(r => r.trust_level === trustFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        r =>
          r.rig_handle.toLowerCase().includes(q) ||
          (r.display_name?.toLowerCase().includes(q) ?? false)
      );
    }
    return result;
  }, [rigs, trustFilter, search]);

  // Register a page header on every render path (including loading / denied)
  // so the navbar shows the right title immediately. Count is `null` when
  // we're not the owner or data hasn't loaded — the header renders without
  // a count badge in that case.
  useSetWastelandPageHeader({
    title: 'Rigs',
    icon: <Truck className="size-4 text-[color:oklch(70%_0.15_30_/_0.6)]" />,
    count: isOwner && rigsQuery.data ? rigs.length : null,
    actions: isUpstreamAdmin ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
        <ShieldCheck className="size-3" />
        Admin mode
      </span>
    ) : null,
  });

  if (wastelandQuery.isLoading || membersQuery.isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 p-6">
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            <EmptyState
              title="Owner access required"
              description="Only wasteland owners can view the rig registry. Contact an owner if you need access."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar — only visible once we have rigs to filter. */}
      {rigs.length > 0 && (
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-6 py-2">
          <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
            <Search className="size-3 text-white/30" />
            <input
              type="text"
              placeholder="Search handle or name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-56 bg-transparent text-xs text-white/80 outline-none placeholder:text-white/25"
            />
          </div>

          <div className="flex items-center gap-1">
            <TrustChip
              label="All"
              count={rigs.length}
              active={trustFilter === null}
              onClick={() => setTrustFilter(null)}
            />
            {[3, 2, 1, 0].map(level => {
              const count = trustCounts[level] ?? 0;
              if (count === 0) return null;
              return (
                <TrustChip
                  key={level}
                  label={`Trust ${level}`}
                  count={count}
                  active={trustFilter === level}
                  onClick={() => setTrustFilter(trustFilter === level ? null : level)}
                />
              );
            })}
          </div>

          {(search || trustFilter !== null) && (
            <span className="ml-auto text-[11px] text-white/30">
              {filteredRigs.length} of {rigs.length}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          <div>
            <p className="text-sm text-white/60">
              Contributors registered on this wasteland's upstream DoltHub repo.
              {isUpstreamAdmin
                ? ' Owners with admin mode can change trust levels directly.'
                : ' Enable admin mode in settings to change trust levels.'}
            </p>
          </div>

          {rigsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="size-3.5 animate-spin text-white/30" />
              <span className="text-xs text-white/40">Loading rigs...</span>
            </div>
          ) : rigsQuery.isError ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-400">Failed to fetch rigs</p>
              <p className="mt-1 font-mono text-[11px] text-white/40">{rigsQuery.error.message}</p>
              {!isUpstreamAdmin && (
                <p className="mt-2 text-[11px] text-white/50">
                  This page queries the upstream repo directly. Connect DoltHub in settings to load
                  it.
                </p>
              )}
            </div>
          ) : rigs.length === 0 ? (
            <EmptyState
              title="No rigs registered yet"
              description="When contributors join this wasteland, their rigs show up here."
            />
          ) : filteredRigs.length === 0 ? (
            <EmptyState
              title="No rigs match"
              description={
                search
                  ? `No rigs match "${search}".`
                  : 'No rigs at this trust level. Clear the filter to see all rigs.'
              }
            />
          ) : (
            <div className="space-y-2">
              {filteredRigs.map(rig => (
                <div
                  key={rig.rig_handle}
                  className="group flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] transition-colors hover:border-white/[0.1] hover:bg-white/[0.03]"
                >
                  <button
                    type="button"
                    onClick={() => openDrawer({ type: 'rig', wastelandId, handle: rig.rig_handle })}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                  >
                    <Truck className="size-4 shrink-0 text-white/40" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-white/70">{rig.rig_handle}</p>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/30">
                        {rig.display_name && <span>{rig.display_name}</span>}
                        {(() => {
                          const registered = parseDoltDate(rig.registered_at);
                          return registered ? (
                            <span>Joined {formatDistanceToNow(registered)} ago</span>
                          ) : null;
                        })()}
                        {(() => {
                          const lastSeen = parseDoltDate(rig.last_seen_at);
                          return lastSeen ? (
                            <span>Seen {formatDistanceToNow(lastSeen)} ago</span>
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <ChevronRight className="size-3.5 shrink-0 text-white/15 transition-colors group-hover:text-white/40" />
                  </button>
                  <div className="pr-4">
                    {isUpstreamAdmin ? (
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
                        className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-xs text-white/80 outline-none focus:border-white/20 disabled:opacity-50"
                      >
                        {[0, 1, 2, 3].map(level => (
                          <option key={level} value={level}>
                            Trust {level}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="outline" className="border-white/[0.08] text-white/50">
                        Trust {rig.trust_level}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-6 py-12 text-center">
      <Truck className="mx-auto mb-3 size-8 text-white/15" />
      <p className="text-sm text-white/70">{title}</p>
      <p className="mt-1 text-xs text-white/40">{description}</p>
    </div>
  );
}

function TrustChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
        active
          ? 'bg-white/[0.08] text-white/70'
          : 'text-white/30 hover:bg-white/[0.04] hover:text-white/50'
      }`}
    >
      {label}
      <span className="font-mono text-[9px] opacity-60">{count}</span>
    </button>
  );
}
