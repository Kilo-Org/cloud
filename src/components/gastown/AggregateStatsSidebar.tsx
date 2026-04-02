import { Card, CardContent } from '@/components/ui/card';

type AggregateStatsSidebarProps = {
  stats: {
    towns: number;
    agents: {
      working: number;
      idle: number;
      stalled: number;
      dead: number;
      total: number;
    };
    beads: {
      open: number;
      inProgress: number;
      failed: number;
      triageRequests: number;
    };
  };
};

export function AggregateStatsSidebar({ stats }: AggregateStatsSidebarProps) {
  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-white/[0.03]">
        <CardContent className="p-4">
          <h3 className="text-sm font-medium text-white/90">Aggregated Stats</h3>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Towns</div>
              <div className="text-xl font-semibold text-white/85">{stats.towns}</div>
            </div>
            <div>
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Total Agents</div>
              <div className="text-xl font-semibold text-white/85">{stats.agents.total}</div>
            </div>
            <div>
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Open Beads</div>
              <div className="text-xl font-semibold text-white/85">{stats.beads.open}</div>
            </div>
            <div>
              <div className="text-[11px] tracking-wider text-white/40 uppercase">Failed Beads</div>
              <div className="text-xl font-semibold text-white/85">{stats.beads.failed}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
