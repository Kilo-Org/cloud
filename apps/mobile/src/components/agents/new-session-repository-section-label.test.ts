import { type TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { group, mountSection, renderedText } from './new-session-repository-section.test-helpers';

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

const collapseState = vi.hoisted(() => ({
  collapsedCtas: [] as string[],
  hasLoaded: true,
  setConnectCtaCollapsed: vi.fn(),
}));
vi.mock('@/lib/hooks/use-collapsed-connect-ctas-preference', () => ({
  useCollapsedConnectCtas: () => ({
    collapsedCtas: collapseState.collapsedCtas,
    hasLoaded: collapseState.hasLoaded,
  }),
  setConnectCtaCollapsed: collapseState.setConnectCtaCollapsed,
}));

/** The Text node that renders exactly `text`, so its own props can be asserted. */
function labelNode(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType('Text' as never).find(node => node.children.includes(text));
}

describe('NewSessionRepositorySection open label', () => {
  it('keeps the open label on one line in the row remaining width', () => {
    // The label measured a fraction narrower than the glyphs Android lays out,
    // so it wrapped onto a second line inside a button with room for one.
    const renderer = mountSection({ groups: [group('gitlab', 'connect')] });

    const label = labelNode(renderer, i18n.t('agentChat.newSession.openGitlab'));

    expect(label).toBeDefined();
    expect(label?.props.numberOfLines).toBe(1);
    expect(label?.props.className).toContain('flex-1');
    expect(label?.props.className).toContain('text-center');
  });

  it('offsets the label with a logical inline-end margin so RTL stays centred', () => {
    const renderer = mountSection({ groups: [group('gitlab', 'connect')] });

    const className = labelNode(renderer, i18n.t('agentChat.newSession.openGitlab'))?.props
      .className as string;

    expect(className).toContain('me-[23px]');
    expect(className).not.toMatch(/\bmr-|margin-?[rR]ight/);
  });

  it('renders no open label in the connected-empty card', () => {
    const renderer = mountSection({ groups: [group('gitlab', 'connected-empty')] });

    expect(renderedText(renderer)).toContain(i18n.t('agentChat.newSession.gitlabConnected'));
    expect(labelNode(renderer, i18n.t('agentChat.newSession.openGitlab'))).toBeUndefined();
  });
});
