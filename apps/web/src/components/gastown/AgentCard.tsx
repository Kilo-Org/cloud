'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Bot, Crown, Shield, Eye, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'motion/react';

type Agent = {
  id: string;
  role: string;
  name: string;
  identity: string;
  status: string;
  current_hook_bead_id: string | null;
  last_activity_at: string | null;
  checkpoint?: unknown;
  created_at: string;
  agent_status_message?: string | null;
  agent_status_updated_at?: string | null;
};

type AgentCardProps = {
  agent: Agent;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
};

const roleIcons: Record<string, React.ElementType> = {
  polecat: Bot,
  mayor: Crown,
  refinery: Shield,
  witness: Eye,
};

const statusColors: Record<string, string> = {
  idle: 'bg-white/30',
  working: 'bg-green-500',
  blocked: 'bg-yellow-500',
  dead: 'bg-red-500',
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

export function AgentCard({ agent, isSelected, onSelect, onDelete }: AgentCardProps) {
  const Icon = roleIcons[agent.role] ?? Bot;

  const showStatusBubble =
    agent.status === 'working' &&
    agent.agent_status_message != null &&
    agent.agent_status_message.length > 0;

  const isStale =
    showStatusBubble &&
    agent.agent_status_updated_at != null &&
    Date.now() - new Date(agent.agent_status_updated_at).getTime() > TEN_MINUTES_MS;

  const truncatedMessage =
    agent.agent_status_message && agent.agent_status_message.length > 80
      ? `${agent.agent_status_message.slice(0, 80)}…`
      : (agent.agent_status_message ?? '');

  return (
    <Card
      className={cn(
        'cursor-pointer border transition-[border-color,background-color]',
        'hover:bg-white/[0.05]',
        isSelected
          ? 'border-[color:oklch(95%_0.15_108_/_0.45)] bg-[color:oklch(95%_0.15_108_/_0.06)]'
          : 'border-white/10 bg-white/[0.03]'
      )}
      onClick={onSelect}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full border border-white/10 bg-black/30">
            <Icon className="size-4 text-white/70" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-white/85">{agent.name}</span>
              <div className={cn('size-2 shrink-0 rounded-full', statusColors[agent.status])} />
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {agent.role}
              </Badge>
              <span className="text-xs text-white/50">{agent.status}</span>
            </div>
          </div>
        </div>
        {agent.current_hook_bead_id && (
          <p className="mt-2 text-xs text-white/55">
            Hooked:{' '}
            <span className="font-mono text-[11px]">{agent.current_hook_bead_id.slice(0, 8)}…</span>
          </p>
        )}
        <div className="mt-1 flex items-center justify-between">
          <p className="text-xs text-white/40">
            {agent.last_activity_at
              ? `Active ${formatDistanceToNow(new Date(agent.last_activity_at), { addSuffix: true })}`
              : 'No activity yet'}
          </p>
          {onDelete && (
            <button
              onClick={e => {
                e.stopPropagation();
                onDelete();
              }}
              className="rounded p-1 text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>

        <AnimatePresence>
          {showStatusBubble && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: isStale ? 0.35 : 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="mt-2 rounded-lg border border-white/[0.07] bg-white/[0.04] px-2.5 py-1.5"
            >
              <p
                className={cn(
                  'text-xs leading-snug italic',
                  isStale ? 'text-white/30' : 'text-white/65'
                )}
              >
                {truncatedMessage}
              </p>
              {agent.agent_status_updated_at && (
                <p className="mt-0.5 text-[10px] text-white/30">
                  {formatDistanceToNow(new Date(agent.agent_status_updated_at), {
                    addSuffix: true,
                  })}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
