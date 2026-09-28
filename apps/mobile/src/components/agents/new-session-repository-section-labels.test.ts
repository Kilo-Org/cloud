import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { type TestRenderer } from '@/test/renderer';
import { group, mountSection } from './new-session-repository-section.test-helpers';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ExternalLink: 'ExternalLink',
  RefreshCw: 'RefreshCw',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/repo-selector', () => ({ RepoSelector: 'RepoSelector' }));
vi.mock('@/components/agents/repository-branch-selector', () => ({
  RepositoryBranchSelector: 'RepositoryBranchSelector',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
  selectReducedMotionEntrance: <T>(reducedMotion: boolean, entrance: T) =>
    reducedMotion ? undefined : entrance,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: number, config: unknown) => ({ value, config }),
  FadeIn: { duration: (ms: number) => ({ __fadeIn: ms }) },
  LinearTransition: { duration: (ms: number) => ({ __linearTransition: ms }) },
}));
vi.mock('@/lib/hooks/use-collapsed-connect-ctas-preference', () => ({
  useCollapsedConnectCtas: () => ({ collapsedCtas: [], hasLoaded: true }),
  setConnectCtaCollapsed: vi.fn(),
}));

/** The connect action's own label node, matched by the copy it renders. */
function actionLabel(renderer: TestRenderer.ReactTestRenderer, copy: string) {
  const node = renderer.root
    .findAllByType('Text' as never)
    .find(candidate => candidate.children.includes(copy));
  if (!node) {
    throw new Error(`no action label for ${copy}`);
  }
  return node;
}

// The connect action is a fixed one-row control: an icon, the label, and the
// refresh button beside it. A label that wraps grows its own text block without
// growing the row, so "Open GitLab" broke onto two lines inside a button left at
// the height of the one-line "Open GitHub" sibling (explorer: new-session-filled
// / new-session-kb-down). Every action label is held to one line, like the
// segmented control's options; a longer locale ellipsizes and the full copy
// stays the control's accessible name.
describe('NewSessionRepositorySection connect action labels', () => {
  it.each(['openGithub', 'openGitlab', 'openBitbucket'] as const)(
    'keeps the %s action label on one line',
    key => {
      const renderer = mountSection({
        groups: [
          group('github', 'connect'),
          group('gitlab', 'connect'),
          group('bitbucket', 'connect'),
        ],
      });

      expect(actionLabel(renderer, i18n.t(`agentChat.newSession.${key}`)).props.numberOfLines).toBe(
        1
      );
    }
  );

  it('keeps the selected-provider action label on one line', () => {
    const renderer = mountSection({
      value: 'github:owner/repo',
      groups: [group('github', 'repos'), group('gitlab', 'connect')],
    });

    expect(actionLabel(renderer, i18n.t('common.connectGitlab')).props.numberOfLines).toBe(1);
  });
});
