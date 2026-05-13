import { describe, expect, it, vi } from 'vitest';

import { HomeScreen } from '@/components/home/home-screen';

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('expo-router', () => ({
  useFocusEffect: vi.fn(),
  useIsFocused: () => true,
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('@kilocode/notifications', () => ({
  badgeBucketForInstance: (sandboxId: string) => sandboxId,
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
vi.mock('@/components/home/kiloclaw-promo-card', () => ({
  KiloClawPromoCard: () => null,
}));
vi.mock('@/components/home/new-task-button', () => ({
  NewTaskButton: () => null,
}));
vi.mock('@/components/home/section-header', () => ({
  SectionHeader: () => null,
}));
vi.mock('@/components/kiloclaw/instance-card', () => ({
  KiloClawCard: () => null,
}));
vi.mock('@/components/kiloclaw/status-badge', () => ({
  isTransitionalStatus: () => false,
}));
vi.mock('@/components/profile-avatar-button', () => ({
  ProfileAvatarButton: () => null,
}));
vi.mock('@/components/screen-header', () => ({
  ScreenHeader: () => null,
}));
vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => null,
}));
vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => ({ activeSessions: [], isLoading: false, storedSessions: [] }),
}));
vi.mock('@/lib/hooks/use-instance-context', () => ({
  useAllKiloClawInstances: () => ({
    data: [],
    isError: false,
    isPending: false,
  }),
}));
vi.mock('@/lib/hooks/use-unread-counts', () => ({
  useUnreadCounts: () => ({ byBadgeBucket: new Map() }),
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    kiloclaw: {
      getStatus: { queryKey: () => ['kiloclaw', 'getStatus'] },
      listAllInstances: { queryKey: () => ['kiloclaw', 'listAllInstances'] },
    },
  }),
}));

describe('HomeScreen copy', () => {
  it('does not show the first-time welcome headline on the main page', () => {
    expect(HomeScreen.toString()).not.toContain('Welcome to Kilo');
  });
});
