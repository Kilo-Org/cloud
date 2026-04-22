'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWastelandTRPC } from '@/lib/wasteland/trpc';
import { useUser } from '@/hooks/useUser';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Truck, Loader2, ShieldCheck, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useSetWastelandPageHeader } from '../WastelandPageHeaderContext';
import { useDrawerStack } from '@/components/wasteland/drawer/WastelandDrawerStack';

export function RigsClient({ wastelandId }: { wastelandId: string }) {
  const trpc = useWastelandTRPC();
  const queryClient = useQueryClient();
  const { data: currentUser } = useUser();
  const { open: openDrawer } = useDrawerStack();

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

  const rigs = rigsQuery.data?.rigs ?? [];

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
          ) : (
            <div className="space-y-2">
              {rigs.map(rig => (
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
                        {rig.registered_at && (
                          <span>Joined {formatDistanceToNow(new Date(rig.registered_at))} ago</span>
                        )}
                        {rig.last_seen_at && (
                          <span>Seen {formatDistanceToNow(new Date(rig.last_seen_at))} ago</span>
                        )}
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
