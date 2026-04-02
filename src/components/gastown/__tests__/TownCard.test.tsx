import { render, screen } from '@testing-library/react';
import { TownCard } from '../TownCard';

describe('TownCard', () => {
  it('renders town info correctly', () => {
    const town = {
      id: '1',
      name: 'Test Town',
      last_activity_at: '2026-04-02T10:00:00Z',
    };
    const stats = {
      bead_counts: {
        total: 10,
        in_progress: 2,
      },
      active_agent_count: 3,
      sparkline_data: [1, 2, 3],
    };
    render(<TownCard town={town} stats={stats} onClick={() => {}} />);
    expect(screen.getByText('Test Town')).toBeInTheDocument();
    expect(screen.getByText('3 agents')).toBeInTheDocument();
    expect(screen.getByText('2 in progress')).toBeInTheDocument();
    expect(screen.getByText('10 total beads')).toBeInTheDocument();
  });
});
