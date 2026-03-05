'use client';

import { useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useGastownTRPC } from '@/lib/gastown/trpc';
import { useDrawerStack } from '@/components/gastown/DrawerStack';
import { Bot, Crown, Shield, Eye, Clock, Hexagon } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';
import type { GastownOutputs } from '@/lib/gastown/trpc';

type Agent = GastownOutputs['gastown']['listAgents'][number];

const ROLE_ICONS: Record<string, typeof Bot> = {
  polecat: Bot,
  mayor: Crown,
  refinery: Shield,
  witness: Eye,
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-white/20',
  working: 'bg-emerald-400',
  stalled: 'bg-amber-400',
  dead: 'bg-red-400',
};

export function AgentsPageClient({ townId }: { townId: string }) {
  const trpc = useGastownTRPC();
  const { open: openDrawer } = useDrawerStack();

  const rigsQuery = useQuery(trpc.gastown.listRigs.queryOptions({ townId }));
  const rigs = rigsQuery.data ?? [];

  const rigAgentQueries = useQueries({
    queries: rigs.map(rig => ({
      ...trpc.gastown.listAgents.queryOptions({ rigId: rig.id }),
      refetchInterval: 5_000,
    })),
  });

  const rigAgentData = rigAgentQueries.map(q => q.data);
  const allAgents = useMemo(() => {
    const agents: Array<Agent & { rigName: string; rigId: string }> = [];
    rigAgentData.forEach((data, i) => {
      const rig = rigs[i];
      if (data && rig) {
        for (const agent of data) {
          agents.push({ ...agent, rigName: rig.name, rigId: rig.id });
        }
      }
    });
    return agents;
  }, [rigAgentData, rigs]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-[color:oklch(95%_0.15_108_/_0.6)]" />
          <h1 className="text-lg font-semibold tracking-tight text-white/90">Agents</h1>
          <span className="ml-1 font-mono text-xs text-white/30">{allAgents.length}</span>
        </div>
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {allAgents.length === 0 && !rigsQuery.isLoading && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Bot className="mb-3 size-8 text-white/10" />
            <p className="text-sm text-white/30">No agents have been spawned yet.</p>
            <p className="mt-1 text-xs text-white/20">Sling work on a rig to create agents.</p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {allAgents.map((agent, i) => {
              const RoleIcon = ROLE_ICONS[agent.role] ?? Bot;
              const rigId = (agent as Agent & { rigId: string }).rigId;
              return (
                <motion.div
                  key={agent.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: i * 0.03, duration: 0.2 }}
                  onClick={() => openDrawer({ type: 'agent', agentId: agent.id, rigId, townId })}
                  className="group cursor-pointer rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition-colors hover:border-white/[0.12] hover:bg-white/[0.04]"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-white/[0.05]">
                        <RoleIcon className="size-4 text-white/50" />
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-white/85">{agent.name}</span>
                          <span
                            className={`size-1.5 rounded-full ${STATUS_COLORS[agent.status] ?? 'bg-white/20'}`}
                          />
                        </div>
                        <div className="text-[10px] text-white/35 capitalize">{agent.role}</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-3 text-[10px] text-white/30">
                    <span className="inline-flex items-center gap-1">
                      <Hexagon className="size-2.5" />
                      {agent.current_hook_bead_id ? agent.current_hook_bead_id.slice(0, 8) : 'idle'}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="size-2.5" />
                      {agent.last_activity_at
                        ? formatDistanceToNow(new Date(agent.last_activity_at), {
                            addSuffix: true,
                          })
                        : 'never'}
                    </span>
                  </div>

                  <div className="mt-2 text-[10px] text-white/20">
                    {(agent as Agent & { rigName: string }).rigName}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
