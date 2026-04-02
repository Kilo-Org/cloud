import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'motion/react';

type TownCardProps = {
  town: {
    id: string;
    name: string;
    last_activity_at: string | null;
  };
  stats: {
    bead_counts: {
      total: number;
      in_progress: number;
    };
    active_agent_count: number;
    sparkline_data: number[]; // 48 buckets
  };
  onClick: () => void;
};

export function TownCard({ town, stats, onClick }: TownCardProps) {
  return (
    <Card
      className={cn(
        'cursor-pointer border border-white/10 bg-white/[0.03] transition-[border-color,background-color]',
        'hover:bg-white/[0.05]'
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white/90 truncate">{town.name}</h3>
          <div className="flex items-center gap-2 text-xs text-white/50">
            <span>{stats.active_agent_count} agents</span>
            <div className="h-3 w-px bg-white/10" />
            <span>
              {town.last_activity_at
                ? formatDistanceToNow(new Date(town.last_activity_at), { addSuffix: true })
                : 'No activity'}
            </span>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <div className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-300">
            {stats.bead_counts.in_progress} in progress
          </div>
          <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-white/40">
            {stats.bead_counts.total} total beads
          </div>
        </div>

        <div className="mt-4 h-12 w-full flex items-end gap-0.5">
          {stats.sparkline_data.map((value, i) => (
            <motion.div
              key={i}
              className="flex-1 rounded-sm bg-white/10"
              initial={{ height: 0 }}
              animate={{ height: `${(value / Math.max(...stats.sparkline_data, 1)) * 100}%` }}
              transition={{ duration: 0.5 }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
