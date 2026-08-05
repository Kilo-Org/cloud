import { describe, expect, it, vi } from 'vitest';

import { HomeScreen } from '@/components/home/home-screen';

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('react-native', () => ({
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
  LinearTransition: {},
}));
vi.mock('@/components/home/agent-sessions-section', () => ({
  AgentSessionsSection: () => null,
}));
vi.mock('@/components/home/agents-promo-card', () => ({
  AgentsPromoCard: () => null,
}));
vi.mock('@/components/home/greeting', () => ({
  buildTimedGreeting: () => 'Good morning',
}));
vi.mock('@/components/home/new-task-button', () => ({
  NewTaskButton: () => null,
}));
vi.mock('@/components/query-error', () => ({
  QueryError: () => null,
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'ScrollView',
  useTabBarBottomPadding: () => 0,
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => null,
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => ({ activeSessions: [], isLoading: false, storedSessions: [] }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));

describe('HomeScreen copy', () => {
  it('does not show the first-time welcome headline on the main page', () => {
    expect(HomeScreen.toString()).not.toContain('Welcome to Kilo');
  });

  it('renders no KiloClaw surface', () => {
    expect(HomeScreen.toString()).not.toContain('KiloClaw');
  });
});
