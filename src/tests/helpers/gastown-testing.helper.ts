export interface TownCardProps {
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
    sparkline_data: number[];
  };
  onClick: () => void;
}

export interface AggregateStatsSidebarProps {
  stats: {
    total_towns: number;
    active_agents: number;
    total_beads: number;
  };
}

export function createMockTownCardProps(
  overrides?: Partial<TownCardProps>
): TownCardProps {
  return {
    town: {
      id: 'mock-town-id',
      name: 'Mock Town',
      last_activity_at: new Date().toISOString(),
      ...(overrides?.town ?? {}),
    },
    stats: {
      bead_counts: {
        total: 10,
        in_progress: 5,
        ...(overrides?.stats?.bead_counts ?? {}),
      },
      active_agent_count: 2,
      sparkline_data: [1, 2, 3, 4, 5],
      ...(overrides?.stats ?? {}),
    },
    onClick: () => {},
    ...overrides,
  };
}

export function createMockAggregateStatsSidebarProps(
  overrides?: Partial<AggregateStatsSidebarProps>
): AggregateStatsSidebarProps {
  return {
    stats: {
      total_towns: 5,
      active_agents: 10,
      total_beads: 50,
      ...(overrides?.stats ?? {}),
    },
    ...overrides,
  };
}
