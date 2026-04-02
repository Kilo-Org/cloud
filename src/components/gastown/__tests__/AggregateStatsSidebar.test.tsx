import { render, screen } from '@testing-library/react';
import { AggregateStatsSidebar } from '../AggregateStatsSidebar';

describe('AggregateStatsSidebar', () => {
  it('renders stats correctly', () => {
    const stats = {
      total_towns: 5,
      active_agents: 10,
      total_beads: 20,
    };
    render(<AggregateStatsSidebar stats={stats} />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });
});
