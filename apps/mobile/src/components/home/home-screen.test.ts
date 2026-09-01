import { describe, expect, it, vi } from 'vitest';

import { HomeScreen } from '@/components/home/home-screen';

vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('react-native', () => ({
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
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
vi.mock('@/components/home/product-choices', () => ({
  ProductChoices: () => null,
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
}));
vi.mock('@/components/context-control', () => ({ ContextControl: () => null }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'ScrollView',
  useTabBarBottomPadding: () => 0,
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useLiveAgentSessions: () => ({ activeSessions: [], hasAcceptedSuccess: false }),
}));

describe('HomeScreen copy', () => {
  it('does not show the first-time welcome headline on the main page', () => {
    expect(HomeScreen.toString()).not.toContain('Welcome to Kilo');
  });

  it('renders no KiloClaw surface', () => {
    expect(HomeScreen.toString()).not.toContain('KiloClaw');
  });
});
