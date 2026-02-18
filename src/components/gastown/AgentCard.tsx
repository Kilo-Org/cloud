'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Bot, Crown, Shield, Eye } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type Agent = {
  id: string;
  role: string;
  name: string;
  identity: string;
  status: string;
  current_hook_bead_id: string | null;
  last_activity_at: string;
  checkpoint: string | null;
  created_at: string;
};

type AgentCardProps = {
  agent: Agent;
  isSelected: boolean;
  onSelect: () => void;
};

const roleIcons: Record<string, React.ElementType> = {
  polecat: Bot,
  mayor: Crown,
  refinery: Shield,
  witness: Eye,
};

const statusColors: Record<string, string> = {
  idle: 'bg-gray-500',
  working: 'bg-green-500',
  blocked: 'bg-yellow-500',
  dead: 'bg-red-500',
};

export function AgentCard({ agent, isSelected, onSelect }: AgentCardProps) {
  const Icon = roleIcons[agent.role] ?? Bot;

  return (
    <Card
      className={cn(
        'cursor-pointer border transition-colors',
        isSelected ? 'border-blue-500/50 bg-blue-500/5' : 'border-gray-700 hover:bg-gray-800/50'
      )}
      onClick={onSelect}
    >
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-gray-700">
            <Icon className="size-4 text-gray-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-gray-200">{agent.name}</span>
              <div className={cn('size-2 shrink-0 rounded-full', statusColors[agent.status])} />
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {agent.role}
              </Badge>
              <span className="text-xs text-gray-500">{agent.status}</span>
            </div>
          </div>
        </div>
        {agent.current_hook_bead_id && (
          <p className="mt-2 text-xs text-gray-500">
            Hooked: {agent.current_hook_bead_id.slice(0, 8)}...
          </p>
        )}
        <p className="mt-1 text-xs text-gray-600">
          Active {formatDistanceToNow(new Date(agent.last_activity_at), { addSuffix: true })}
        </p>
      </CardContent>
    </Card>
  );
}
