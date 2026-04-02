import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BookOpen } from 'lucide-react';

type AggregateStatsSidebarProps = {
  stats: {
    total_towns: number;
    active_agents: number;
    total_beads: number;
  };
};

export function AggregateStatsSidebar({ stats }: AggregateStatsSidebarProps) {
  return (
    <aside className="sticky top-4 hidden w-64 flex-col gap-4 lg:flex">
      <Card className="border border-white/10 bg-white/[0.03]">
        <CardContent className="p-4">
          <h2 className="text-sm font-semibold text-white/90">Overview Stats</h2>
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">Total Towns</span>
              <span className="font-mono text-white/90">{stats.total_towns}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">Active Agents</span>
              <span className="font-mono text-white/90">{stats.active_agents}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">Total Beads</span>
              <span className="font-mono text-white/90">{stats.total_beads}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border border-white/10 bg-white/[0.03]">
        <CardContent className="p-4">
          <h2 className="text-sm font-semibold text-white/90">Documentation</h2>
          <div className="mt-2 flex flex-col gap-2">
            <a href="#" className="flex items-center gap-2 text-xs text-white/60 hover:text-white">
              <BookOpen className="size-3" />
              Gastown Overview
            </a>
            <a href="#" className="flex items-center gap-2 text-xs text-white/60 hover:text-white">
              <BookOpen className="size-3" />
              Working with Beads
            </a>
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}
