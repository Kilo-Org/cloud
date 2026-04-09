'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { sortAgentsByStatus } from '@/lib/gastown/sort-agents';
import { Button } from '@/components/Button';
import { Skeleton } from '@/components/ui/skeleton';
import { CreateRigDialog } from '@/components/gastown/CreateRigDialog';
import { ActivityFeedView } from '@/components/gastown/ActivityFeed';
import { ConvoyTimeline } from '@/components/gastown/ConvoyTimeline';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { SystemTopology } from '@/components/gastown/SystemTopology';
import {
  Plus,
  GitBranch,
  Trash2,
  Hexagon,
  Bot,
  AlertTriangle,
  Activity,
  Zap,
  Clock,
  Crown,
  Shield,
  Eye,
  ChevronRight,
  ChevronDown,
  Layers,
  MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import type { GastownOutputs } from '@/lib/gastown/trpc';
import { AdminViewingBanner } from '@/components/gastown/AdminViewingBanner';
import { DrainStatusBanner } from '@/components/gastown/DrainStatusBanner';
import { SidebarTrigger } from '@/components/ui/sidebar';

type Agent = GastownOutputs['gastown']['listAgents'][number];

type TownOverviewPageClientProps = {
  townId: string;
  /** Override base path for org-scoped routes (e.g. /organizations/[id]/gastown/[townId]) */
  basePath?: string;
  /** When set, integration queries use org-scoped endpoints. */
  organizationId?: string;
};

const ROLE_ICONS: Record<string, typeof Bot> = {
  polecat: Bot,
  mayor: Crown,
  refinery: Shield,
  witness: Eye,
};

const AGENT_STATUS_DOT: Record<string, string> = {
  idle: 'bg-white/25',
  working: 'bg-emerald-400',
  active: 'bg-emerald-400',
  stalled: 'bg-amber-400',
  dead: 'bg-red-400',
  starting: 'bg-sky-400',
};

/** Bucket events into 30-minute windows for the sparkline chart. */
function bucketEventsOverTime(events: Array<{ created_at: string }>, windowMinutes = 30) {
  if (events.length === 0) return [];

  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;
  const bucketCount = Math.ceil((24 * 60) / windowMinutes);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    time: new Date(now - (bucketCount - 1 - i) * windowMs).toISOString(),
    count: 0,
  }));

  for (const event of events) {
    const ts = new Date(event.created_at).getTime();
    const idx = Math.floor((ts - (now - bucketCount * windowMs)) / windowMs);
    if (idx >= 0 && idx < bucketCount) {
      buckets[idx].count++;
    }
  }

  return buckets;
}

export function TownOverviewPageClient({
  townId,
  basePath: basePathOverride,
  organizationId,
}: TownOverviewPageClientProps) {
  const townBasePath = basePathOverride ?? `/gastown/${townId}`;
  const router = useRouter();
  const trpc = useGastownTRPC();
  const [isCreateRigOpen, setIsCreateRigOpen] = useState(false);
  const [convoysCollapsed, setConvoysCollapsed] = useState(false);
  const { open: openDrawer } = useDrawerStack();

  const queryClient = useQueryClient();
  const townQuery = useQuery(trpc.gastown.getTown.queryOptions({ townId }));
  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const townEventsQuery = useQuery({
    ...trpc.gastown.getTownEvents.queryOptions({ townId, limit: 200 }),
    refetchInterval: 5_000,
  });
  const convoysQuery = useQuery({
    ...trpc.gastown.listConvoys.queryOptions({ townId }),
    refetchInterval: 8_000,
  });
  const closeConvoyMutation = useMutation(
    trpc.gastown.closeConvoy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listConvoys.queryKey({ townId }),
        });
      },
      onError: err => toast.error(err.message),
    })
  );
  const startConvoyMutation = useMutation(
    trpc.gastown.startConvoy.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.gastown.listConvoys.queryKey({ townId }),
        });
        toast.success('Convoy started');
      },
      onError: err => toast.error(err.message),
    })
  );

  const rigs = rigsQuery.data ?? [];
  const events = townEventsQuery.data ?? [];
  const convoys = convoysQuery.data ?? [];

  const activityData = useMemo(() => bucketEventsOverTime(events), [events]);

  // Fetch beads for each rig so stats reflect actual bead state, not event counts.
  const rigBeadQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listBeads.queryOptions({ rigId: rig.id }),
      refetchInterval: 8_000,
    })),
  });

  const rigBeadData = rigBeadQueries.map(q => q.data);
  const allBeads = useMemo(() => {
    return rigBeadData.flatMap((data, i) => {
      const rig = rigs[i];
      return data && rig ? data : [];
    });
  }, [rigBeadData, rigs]);

  // Stats from actual bead state (excluding agent beads)
  const userBeads = allBeads.filter(b => b.type !== 'agent');
  const openBeadCount = userBeads.filter(b => b.status === 'open').length;
  const inProgressBeadCount = userBeads.filter(b => b.status === 'in_progress').length;
  const inReviewBeadCount = userBeads.filter(b => b.status === 'in_review').length;
  const closedBeadCount = userBeads.filter(b => b.status === 'closed').length;
  const escalationsCount = events.filter(e => e.event_type === 'escalated').length;

  // Fetch agents for each rig to populate the recent agents section.
  // useQueries accepts a dynamic-length array (unlike useQuery in a loop).
  const rigAgentQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listAgents.queryOptions({ rigId: rig.id }),
      refetchInterval: 8_000,
    })),
  });

  const rigAgentData = rigAgentQueries.map(q => q.data);
  const agentsByRig = useMemo(() => {
    const map: Record<string, Agent[]> = {};
    rigAgentData.forEach((data, i) => {
      const rig = rigs[i];
      if (data && rig) map[rig.id] = data;
    });
    return map;
  }, [rigAgentData, rigs]);

  const recentAgents = useMemo(() => {
    const agents: Array<Agent & { rigName: string; rigId: string }> = [];
    for (const [rigId, rigAgents] of Object.entries(agentsByRig)) {
      const rig = rigs.find(r => r.id === rigId);
      if (rig) {
        for (const agent of rigAgents) {
          agents.push({ ...agent, rigName: rig.name, rigId: rig.id });
        }
      }
    }
    return sortAgentsByStatus(agents).slice(0, 5);
  }, [agentsByRig, rigs]);

  const deleteRig = useMutation(
    trpc.gastown.deleteRig.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.gastown.listRigs.queryKey() });
        toast.success('Rig deleted');
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  return (
    <div>
      <AdminViewingBanner townId={townId} />
      <div className="px-6">
        <DrainStatusBanner townId={townId} />
      </div>
      {/* Top bar — sticky */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-[oklch(0.1_0_0)] px-6 py-3">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="-ml-3" />
          {townQuery.isLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : (
            <h1 className="text-lg font-semibold tracking-tight text-white/90">
              {townQuery.data?.name}
            </h1>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setIsCreateRigOpen(true)}
          className="gap-1.5 bg-[color:oklch(95%_0.15_108_/_0.90)] text-black hover:bg-[color:oklch(95%_0.15_108_/_0.95)]"
        >
          <Plus className="size-3.5" />
          New Rig
        </Button>
      </div>

      {/* Main content area — no scroll container; viewport scrolls */}
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr_380px]">
        {/* Left column: activity feed */}
        <div className="min-w-0 border-r border-white/[0.06]">
          {/* Stats strip */}
          <div
            className="grid border-b border-white/[0.06]"
            style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}
          >
            <StatCell
              label="Open"
              value={openBeadCount}
              icon={<Hexagon className="size-3.5" />}
              color="text-sky-400"
            />
            <StatCell
              label="In Progress"
              value={inProgressBeadCount}
              icon={<Bot className="size-3.5" />}
              color="text-violet-400"
            />
            <StatCell
              label="In Review"
              value={inReviewBeadCount}
              icon={<Eye className="size-3.5" />}
              color="text-purple-400"
            />
            <StatCell
              label="Closed"
              value={closedBeadCount}
              icon={<Zap className="size-3.5" />}
              color="text-emerald-400"
            />
            <StatCell
              label="Escalations"
              value={escalationsCount}
              icon={<AlertTriangle className="size-3.5" />}
              color="text-orange-400"
            />
          </div>

          {/* Activity chart */}
          <div className="border-b border-white/[0.06] px-5 pt-4 pb-2">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-3.5 text-white/30" />
                <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                  Activity — 24h
                </span>
              </div>
              <span className="font-mono text-[11px] text-white/30">{events.length} events</span>
            </div>
            <div className="h-[100px]">
              {activityData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={activityData}>
                    <defs>
                      <linearGradient id="activityGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="oklch(95% 0.15 108)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="oklch(95% 0.15 108)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="time" hide />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{
                        background: 'oklch(0.15 0 0)',
                        border: '1px solid oklch(1 0 0 / 0.1)',
                        borderRadius: '8px',
                        fontSize: '11px',
                        color: 'oklch(1 0 0 / 0.7)',
                      }}
                      labelFormatter={() => ''}
                      formatter={value => {
                        const displayValue = Array.isArray(value) ? value.join(', ') : (value ?? 0);
                        return [displayValue, 'events'];
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="count"
                      stroke="oklch(95% 0.15 108)"
                      strokeWidth={1.5}
                      fill="url(#activityGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-white/20">
                  No activity data
                </div>
              )}
            </div>
          </div>

          {/* Active Convoys */}
          {convoys.length > 0 && (
            <div className="flex max-h-[40vh] flex-col border-b border-white/[0.06] px-5 pt-4 pb-3">
              <button
                onClick={() => setConvoysCollapsed(v => !v)}
                className="mb-2.5 flex w-full shrink-0 items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <Layers className="size-3.5 text-violet-400/70" />
                  <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                    Active Convoys ({convoys.length})
                  </span>
                </div>
                {convoysCollapsed ? (
                  <ChevronRight className="size-3.5 text-white/25" />
                ) : (
                  <ChevronDown className="size-3.5 text-white/25" />
                )}
              </button>
              <div className="min-h-0 min-w-0 overflow-y-auto">
                <ConvoyTimeline
                  convoys={convoys}
                  collapsed={convoysCollapsed}
                  onSelectBead={(beadId, rigId) => {
                    if (rigId) openDrawer({ type: 'bead', beadId, rigId });
                  }}
                  onSelectConvoy={convoyId => openDrawer({ type: 'convoy', convoyId, townId })}
                  onCloseConvoy={convoyId => closeConvoyMutation.mutate({ townId, convoyId })}
                  onStartConvoy={convoyId => startConvoyMutation.mutate({ townId, convoyId })}
                />
              </div>
            </div>
          )}

          {/* Activity feed — clickable items */}
          <div className="px-2">
            <div className="flex items-center gap-2 px-3 pt-4 pb-2">
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Feed
              </span>
            </div>
            <ActivityFeedView
              townId={townId}
              events={events.slice(0, 80)}
              isLoading={townEventsQuery.isLoading}
              onEventClick={event => {
                if (event.event_type === 'agent_status' && event.agent_id != null) {
                  // rig_id is not on the bead_events row — resolve it from
                  // the already-fetched agentsByRig map instead.
                  const rigId = Object.entries(agentsByRig).find(([, agents]) =>
                    agents.some(a => a.id === event.agent_id)
                  )?.[0];
                  if (rigId) {
                    openDrawer({ type: 'agent', agentId: event.agent_id, rigId, townId });
                    return;
                  }
                }
                openDrawer({ type: 'event', event });
              }}
            />
          </div>
        </div>

        {/* Right column: rigs + recent agents + topology — sticky alongside the feed */}
        <div className="lg:sticky lg:top-[53px] lg:self-start">
          <div className="p-4">
            {/* Rigs */}
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                Rigs ({rigs.length})
              </span>
            </div>

            {rigsQuery.isLoading && (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            )}

            {rigs.length === 0 && !rigsQuery.isLoading && (
              <div className="rounded-xl border border-dashed border-white/10 p-6 text-center">
                <GitBranch className="mx-auto mb-2 size-6 text-white/20" />
                <p className="text-xs text-white/40">No rigs yet. Connect a repo to get started.</p>
                <button
                  onClick={() => setIsCreateRigOpen(true)}
                  className="mt-3 inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-3 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/[0.1] hover:text-white/80"
                >
                  <Plus className="size-3" />
                  Create rig
                </button>
              </div>
            )}

            <AnimatePresence mode="popLayout">
              {rigs.map((rig, i) => (
                <motion.div
                  key={rig.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ delay: i * 0.04, duration: 0.25 }}
                  onClick={() => void router.push(`${townBasePath}/rigs/${rig.id}`)}
                  className="group mb-2 cursor-pointer rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 transition-colors hover:border-white/[0.12] hover:bg-white/[0.04]"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-white/85">{rig.name}</span>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-white/40">
                        <GitBranch className="size-3" />
                        <span>{rig.default_branch}</span>
                        <span className="text-white/20">|</span>
                        <Clock className="size-3" />
                        <span>
                          {formatDistanceToNow(new Date(rig.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        if (confirm(`Delete rig "${rig.name}"?`)) {
                          deleteRig.mutate({ rigId: rig.id });
                        }
                      }}
                      className="rounded p-1 text-white/20 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                  <div className="mt-2 max-w-full truncate font-mono text-[10px] text-white/25">
                    {rig.git_url}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {/* Recent Agents */}
            {recentAgents.length > 0 && (
              <div className="mt-5">
                <div className="mb-2.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium tracking-wide text-white/40 uppercase">
                    Recent Agents
                  </span>
                  <button
                    onClick={() => void router.push(`${townBasePath}/agents`)}
                    className="text-[10px] text-white/25 transition-colors hover:text-white/50"
                  >
                    View all
                  </button>
                </div>
                <div className="space-y-1.5">
                  <AnimatePresence mode="popLayout">
                    {recentAgents.map((agent, i) => {
                      const RoleIcon = ROLE_ICONS[agent.role] ?? Bot;
                      const showStatusBubble =
                        agent.status === 'working' &&
                        agent.agent_status_message != null &&
                        agent.agent_status_message.length > 0;
                      const isStale =
                        showStatusBubble &&
                        agent.agent_status_updated_at != null &&
                        Date.now() - new Date(agent.agent_status_updated_at).getTime() >
                          10 * 60 * 1000;
                      const truncatedMsg =
                        agent.agent_status_message && agent.agent_status_message.length > 80
                          ? `${agent.agent_status_message.slice(0, 80)}…`
                          : (agent.agent_status_message ?? '');
                      return (
                        <motion.div
                          key={agent.id}
                          initial={{ opacity: 0, x: 8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -8 }}
                          transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => {
                            const a = agent as Agent & { rigId: string };
                            openDrawer({
                              type: 'agent',
                              agentId: agent.id,
                              rigId: a.rigId,
                              townId,
                            });
                          }}
                          className="group/agent cursor-pointer rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-2 transition-colors hover:border-white/[0.1] hover:bg-white/[0.03]"
                        >
                          <div className="flex items-center gap-2.5">
                            <div className="relative flex size-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05]">
                              <RoleIcon className="size-3.5 text-white/40" />
                              <span
                                className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-[oklch(0.12_0_0)] ${AGENT_STATUS_DOT[agent.status] ?? 'bg-white/20'}`}
                              />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-medium text-white/75">
                                  {agent.name}
                                </span>
                                <span className="shrink-0 text-[9px] text-white/25 capitalize">
                                  {agent.role}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 text-[10px] text-white/25">
                                <span>{(agent as Agent & { rigName: string }).rigName}</span>
                                <span className="text-white/10">·</span>
                                <span>
                                  {agent.last_activity_at
                                    ? formatDistanceToNow(new Date(agent.last_activity_at), {
                                        addSuffix: true,
                                      })
                                    : 'no activity'}
                                </span>
                              </div>
                            </div>
                            <ChevronRight className="size-3 shrink-0 text-white/0 transition-colors group-hover/agent:text-white/20" />
                          </div>

                          <AnimatePresence>
                            {showStatusBubble && (
                              <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: isStale ? 0.35 : 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.25, ease: 'easeOut' }}
                                className="mt-1.5 flex items-start gap-1.5 rounded-md border border-white/[0.05] bg-white/[0.025] px-2 py-1"
                              >
                                <MessageSquare className="mt-0.5 size-2.5 shrink-0 text-white/20" />
                                <div className="min-w-0 flex-1">
                                  <p
                                    className={`text-[10px] leading-snug italic ${isStale ? 'text-white/20' : 'text-white/50'}`}
                                  >
                                    {truncatedMsg}
                                  </p>
                                  {agent.agent_status_updated_at && (
                                    <p className="mt-0.5 text-[9px] text-white/20">
                                      {formatDistanceToNow(
                                        new Date(agent.agent_status_updated_at),
                                        { addSuffix: true }
                                      )}
                                    </p>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* System Topology (mini view) */}
            {rigs.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 text-[11px] font-medium tracking-wide text-white/40 uppercase">
                  System Topology
                </div>
                <div className="h-[280px] rounded-lg border border-white/[0.06] bg-white/[0.02]">
                  <SystemTopology
                    townName={townQuery.data?.name ?? 'Town'}
                    rigs={rigs}
                    agentsByRig={agentsByRig}
                    recentEvents={events.slice(-10)}
                    onSelectRig={rigId => void router.push(`${townBasePath}/rigs/${rigId}`)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <CreateRigDialog
        townId={townId}
        isOpen={isCreateRigOpen}
        onClose={() => setIsCreateRigOpen(false)}
        organizationId={organizationId}
      />

      {/* Drawers are rendered by the layout-level DrawerStackProvider */}
    </div>
  );
}

function StatCell({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="border-r border-white/[0.06] px-4 py-3 last:border-r-0">
      <div className={`flex items-center gap-1.5 ${color}`}>
        {icon}
        <span className="text-[10px] font-medium tracking-wide uppercase opacity-70">{label}</span>
      </div>
      <motion.div
        key={value}
        initial={{ y: 6, opacity: 0.4 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="mt-1 font-mono text-xl font-semibold text-white/85"
      >
        {value}
      </motion.div>
    </div>
  );
}
