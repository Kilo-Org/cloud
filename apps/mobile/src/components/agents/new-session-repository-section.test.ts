/* oxlint-disable max-lines -- one suite for the repository section: the branch row, Bitbucket restriction, connect-card collapse, one-line connect label, and post-selection compact actions all mount the same section through one hoisted preference mock */
import { act, type TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import {
  branchSelectorProps,
  githubRow,
  gitlabRow,
  group,
  mountSection,
  renderedText,
} from './new-session-repository-section.test-helpers';
import {
  getSelectedBranchOverride,
  resetSelectedBranchOverrides,
  setSelectedBranchOverride,
} from './new-session-repository-state';

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

/** The headers of the connect cards; the section renders no other pressable. */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('Pressable' as never);
}

/** The Text rendering `text`, for the props that decide its layout. */
function labelNode(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAllByType('Text' as never).find(node => node.children.includes(text));
}

function connectHeader(renderer: TestRenderer.ReactTestRenderer, title: string) {
  return pressables(renderer).find(node => node.props.accessibilityLabel === title);
}

/** Press the header of the connect card with the given title. */
function pressHeader(renderer: TestRenderer.ReactTestRenderer, title: string): void {
  const header = connectHeader(renderer, title);
  if (!header) {
    throw new Error(`no connect header for ${title}`);
  }
  act(() => {
    (header.props.onPress as () => void)();
  });
}

beforeEach(() => {
  resetSelectedBranchOverrides();
  collapseState.collapsedCtas = [];
  collapseState.hasLoaded = true;
  collapseState.setConnectCtaCollapsed.mockClear();
});

describe('NewSessionRepositorySection branch row', () => {
  it.each([
    ['github:owner/repo', githubRow],
    ['gitlab:owner/repo', gitlabRow],
    ['', null],
  ] as const)('resolves "%s" to its provider-specific branch row', (value, repository) => {
    const renderer = mountSection({ value });

    expect(branchSelectorProps(renderer)?.repository).toEqual(repository);
  });

  it('hands the branch selector the route organization scope', () => {
    const renderer = mountSection({ value: 'github:owner/repo', organizationId: 'org-1' });

    expect(branchSelectorProps(renderer)?.organizationId).toBe('org-1');
  });

  it('keeps a chosen branch when the run target toggle unmounts the section', () => {
    // Toggling the run target to a remote instance unmounts only this section;
    // the branch override belongs to the screen and must survive, otherwise
    // switching back silently reverts to the provider default.
    const renderer = mountSection({ value: 'github:owner/repo' });
    setSelectedBranchOverride(githubRow, 'release/2.0');

    act(() => {
      renderer.unmount();
    });

    expect(getSelectedBranchOverride(githubRow)).toBe('release/2.0');
  });

  it('offers no branch row on the Continue clone entry', () => {
    // The clone submit path has no `upstreamBranch` field, so a branch row
    // there would show a choice the submit silently drops.
    const renderer = mountSection({ value: 'github:owner/repo', isCloneEntry: true });

    expect(renderer.root.findAllByType('RepositoryBranchSelector' as never)).toHaveLength(0);
  });
});

describe('NewSessionRepositorySection Bitbucket connect card', () => {
  it.each(['', 'github:owner/repo', 'gitlab:owner/repo'])(
    'states outright that Bitbucket is organizations-only with selection "%s"',
    value => {
      const renderer = mountSection({
        value,
        groups: [group('github', 'repos'), group('gitlab', 'repos'), group('bitbucket', 'connect')],
      });

      expect(renderedText(renderer)).toContain(
        i18n.t('agentChat.newSession.bitbucketOrganizationsOnly')
      );
    }
  );

  it('leaves the GitHub connect card free of the Bitbucket restriction', () => {
    const renderer = mountSection({
      groups: [group('github', 'connect'), group('gitlab', 'repos')],
    });

    expect(renderedText(renderer)).not.toContain(
      i18n.t('agentChat.newSession.bitbucketOrganizationsOnly')
    );
  });

  it('hides the organizations-only note when the Bitbucket card is collapsed', () => {
    collapseState.collapsedCtas = ['bitbucket'];
    const renderer = mountSection({
      groups: [group('github', 'repos'), group('gitlab', 'repos'), group('bitbucket', 'connect')],
    });

    expect(renderedText(renderer)).not.toContain(
      i18n.t('agentChat.newSession.bitbucketOrganizationsOnly')
    );
    expect(
      connectHeader(renderer, i18n.t('common.connectBitbucket'))?.props.accessibilityState
    ).toEqual({ expanded: false });
  });
});

describe('NewSessionRepositorySection connect card collapse', () => {
  const bothConnect = [group('github', 'connect'), group('gitlab', 'connect')];

  it('paints every connect card expanded when nothing is persisted as collapsed', () => {
    const renderer = mountSection({ groups: bothConnect });

    const text = renderedText(renderer);
    expect(text).toContain(i18n.t('agentChat.newSession.connectGithubDescription'));
    expect(text).toContain(i18n.t('agentChat.newSession.connectGitlabDescription'));
    expect(
      connectHeader(renderer, i18n.t('common.connectGithub'))?.props.accessibilityState
    ).toEqual({ expanded: true });
    expect(
      connectHeader(renderer, i18n.t('common.connectGitlab'))?.props.accessibilityState
    ).toEqual({ expanded: true });
  });

  it('collapses only the persisted provider and leaves the others expanded', () => {
    collapseState.collapsedCtas = ['github'];
    const renderer = mountSection({ groups: bothConnect });

    const text = renderedText(renderer);
    // Collapsed means reduced, not deleted: the title row stays.
    expect(text).toContain(i18n.t('common.connectGithub'));
    expect(text).not.toContain(i18n.t('agentChat.newSession.connectGithubDescription'));
    expect(text).not.toContain(i18n.t('agentChat.newSession.openGithub'));
    expect(text).toContain(i18n.t('agentChat.newSession.connectGitlabDescription'));

    expect(
      connectHeader(renderer, i18n.t('common.connectGithub'))?.props.accessibilityState
    ).toEqual({ expanded: false });
    expect(
      connectHeader(renderer, i18n.t('common.connectGitlab'))?.props.accessibilityState
    ).toEqual({ expanded: true });
  });

  it.each([false, true])('toggles the persisted collapse state from %s', collapsed => {
    collapseState.collapsedCtas = collapsed ? ['github'] : [];
    const renderer = mountSection({ groups: [group('github', 'connect')] });

    pressHeader(renderer, i18n.t('common.connectGithub'));

    expect(collapseState.setConnectCtaCollapsed).toHaveBeenCalledWith('github', !collapsed);
  });

  it('renders no connect card until the persisted state has loaded', () => {
    collapseState.hasLoaded = false;
    const renderer = mountSection({ groups: [group('github', 'connect')] });

    const text = renderedText(renderer);
    expect(text).not.toContain(i18n.t('common.connectGithub'));
    expect(text).not.toContain(i18n.t('agentChat.newSession.connectGithubDescription'));
    expect(pressables(renderer)).toHaveLength(0);
  });

  it.each([
    { groups: [group('github', 'repos')] },
    { groups: [group('github', 'repos'), group('gitlab', 'repos')] },
  ])('renders no connect card when every provider has repositories: $groups', options => {
    const renderer = mountSection(options);

    expect(renderedText(renderer)).not.toContain(i18n.t('common.connectGithub'));
    expect(pressables(renderer)).toHaveLength(0);
  });
});

describe('NewSessionRepositorySection connect button label', () => {
  it('keeps the connect action label on a single line with the row remaining width', () => {
    // A label sized to its own content is measured at its longest word's width
    // and wraps onto a second line. Taking the row's remaining width gives the
    // one line room, and the pin keeps it single-line on a narrow button.
    const renderer = mountSection({ groups: [group('gitlab', 'connect')] });

    const label = labelNode(renderer, i18n.t('agentChat.newSession.openGitlab'));

    expect(label?.props.numberOfLines).toBe(1);
    expect(String(label?.props.className)).toContain('flex-1');
    expect(String(label?.props.className)).toContain('text-center');
  });

  it('offsets the label with a logical inline-end margin so RTL stays centred', () => {
    // The trailing offset mirrors the leading glyph plus the row gap. It must be
    // the logical `me-*` (React Native resolves `marginInlineEnd` to
    // `marginLeft` under RTL), not the physical `mr-*`: in RTL the row mirrors
    // the glyph to the right, so a physical right margin would offset the label
    // on the same side as the glyph and land it 24px off the button's centre.
    const renderer = mountSection({ groups: [group('gitlab', 'connect')] });

    const className = String(
      labelNode(renderer, i18n.t('agentChat.newSession.openGitlab'))?.props.className
    );

    expect(className).toContain('me-[24px]');
    expect(className).not.toMatch(/\bmr-|margin-?[rR]ight/);
  });
});

describe('NewSessionRepositorySection connect cards after selection', () => {
  it.each([
    ['github', 'Github', gitlabRow],
    ['gitlab', 'Gitlab', githubRow],
    ['bitbucket', 'Bitbucket', githubRow],
  ] as const)('keeps compact %s actions without expanded instructions', (platform, copy, row) => {
    const onConnect = vi.fn(() => undefined);
    const onRefreshRepos = vi.fn(() => undefined);
    collapseState.collapsedCtas = [platform];
    collapseState.hasLoaded = false;
    setSelectedBranchOverride(row, 'release/2.0');
    const renderer = mountSection({
      value: `${row.platform}:${row.fullName}`,
      groups: [group(row.platform, 'repos'), group(platform, 'connect')],
      organizationId: 'org-1',
      onConnect,
      onRefreshRepos,
    });

    const text = renderedText(renderer);
    expect(text).toContain(i18n.t(`common.connect${copy}`));
    expect(text).not.toContain(i18n.t(`agentChat.newSession.connect${copy}Description`));
    expect(text.includes(i18n.t('agentChat.newSession.bitbucketOrganizationsOnly'))).toBe(
      platform === 'bitbucket'
    );
    expect(pressables(renderer)).toHaveLength(0);
    const connect = renderer.root.findAllByType('Button' as never)[0];
    if (!connect) {
      throw new Error('no connect action');
    }
    const refresh = renderer.root.findByProps({
      accessibilityLabel: i18n.t('agentChat.newSession.refreshRepositories'),
    });
    expect(refresh.props.disabled).toBe(false);
    act(() => {
      (connect.props.onPress as () => void)();
      (refresh.props.onPress as () => void)();
    });
    expect(onConnect).toHaveBeenCalledWith(platform);
    expect(onRefreshRepos).toHaveBeenCalledOnce();
    expect(branchSelectorProps(renderer)?.repository).toEqual(row);
    expect(getSelectedBranchOverride(row)).toBe('release/2.0');
  });

  it('keeps one inline wait in the disabled refresh action', () => {
    const renderer = mountSection({
      value: 'github:owner/repo',
      groups: [group('github', 'repos'), group('gitlab', 'connect')],
      isRetrying: true,
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: i18n.t('agentChat.newSession.refreshRepositories'),
      }).props.disabled
    ).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1);
    expect(branchSelectorProps(renderer)?.repository).toEqual(githubRow);
  });

  it('keeps a retryable provider error recoverable after selection', () => {
    const onRefreshRepos = vi.fn(() => undefined);
    const renderer = mountSection({
      value: 'github:owner/repo',
      groups: [group('github', 'repos'), group('gitlab', 'error')],
      onRefreshRepos,
    });
    const error = renderer.root.findByType('QueryError' as never);
    expect(error.props.title).toBe(i18n.t('agentChat.newSession.couldNotLoadGitlabRepositories'));
    act(() => {
      (error.props.onRetry as () => void)();
    });
    expect(onRefreshRepos).toHaveBeenCalledOnce();
    expect(branchSelectorProps(renderer)?.repository).toEqual(githubRow);
  });

  it('keeps connected-empty guidance and refresh after selection', () => {
    const onRefreshRepos = vi.fn(() => undefined);
    const renderer = mountSection({
      value: 'github:owner/repo',
      groups: [group('github', 'repos'), group('gitlab', 'connected-empty')],
      onRefreshRepos,
    });
    expect(renderedText(renderer)).toContain(
      i18n.t('agentChat.newSession.noRepositoriesVisibleGitlab')
    );
    const refresh = renderer.root.findByProps({
      accessibilityLabel: i18n.t('agentChat.newSession.refreshRepositories'),
    });
    act(() => {
      (refresh.props.onPress as () => void)();
    });
    expect(onRefreshRepos).toHaveBeenCalledOnce();
  });

  it('keeps the connect prompt while no repository is selected', () => {
    const renderer = mountSection({
      value: '',
      groups: [group('github', 'repos'), group('gitlab', 'connect')],
    });

    expect(renderedText(renderer)).toContain(
      i18n.t('agentChat.newSession.connectGitlabDescription')
    );
  });
});
