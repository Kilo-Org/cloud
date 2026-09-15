import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { NewSessionRepositorySection } from './new-session-repository-section';
import {
  getSelectedBranchOverride,
  type NewSessionRepository,
  type RepositoryGroup,
  resetSelectedBranchOverrides,
  setSelectedBranchOverride,
} from './new-session-repository-state';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  View: 'View',
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ ExternalLink: 'ExternalLink', RefreshCw: 'RefreshCw' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/repo-selector', () => ({ RepoSelector: 'RepoSelector' }));
vi.mock('@/components/agents/repository-branch-selector', () => ({
  RepositoryBranchSelector: 'RepositoryBranchSelector',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
}));

const githubRow: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
const gitlabRow: NewSessionRepository = {
  platform: 'gitlab',
  fullName: 'owner/repo',
  isPrivate: false,
};

const group = (
  key: RepositoryGroup['key'],
  status: RepositoryGroup['status'],
  repositories: NewSessionRepository[] = []
): RepositoryGroup => ({ key, status, repositories });

function mountSection(overrides: {
  value?: string;
  organizationId?: string;
  repositories?: NewSessionRepository[];
  groups?: RepositoryGroup[];
}) {
  const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    renderer.current = TestRenderer.create(
      createElement(NewSessionRepositorySection, {
        organizationId: overrides.organizationId,
        disabled: false,
        isRetrying: false,
        onChange: vi.fn(() => undefined),
        onConnect: vi.fn(() => undefined),
        onRefreshRepos: vi.fn(() => undefined),
        repositories: overrides.repositories ?? [githubRow, gitlabRow],
        recents: [],
        groups: overrides.groups ?? [group('github', 'repos'), group('gitlab', 'repos')],
        value: overrides.value ?? '',
      })
    );
  });
  const created = renderer.current;
  if (created === null) {
    throw new Error('the section did not render');
  }
  return created;
}

function branchSelectorProps(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType('RepositoryBranchSelector' as never)[0]?.props as {
    repository: NewSessionRepository | null;
    organizationId: string | undefined;
    disabled: boolean;
  };
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

beforeEach(() => {
  resetSelectedBranchOverrides();
});

describe('NewSessionRepositorySection branch row', () => {
  it('hands the branch selector the resolved repository row', () => {
    const renderer = mountSection({ value: 'github:owner/repo' });

    expect(branchSelectorProps(renderer).repository).toEqual(githubRow);
  });

  it('keeps same-named rows on two providers distinct', () => {
    const renderer = mountSection({ value: 'gitlab:owner/repo' });

    expect(branchSelectorProps(renderer).repository).toEqual(gitlabRow);
  });

  it('offers no branch row until a repository is selected', () => {
    const renderer = mountSection({ value: '' });

    expect(branchSelectorProps(renderer).repository).toBeNull();
  });

  it('keeps the chosen branch when the run target unmounts the section', () => {
    // The section renders only while the run target is the cloud agent:
    // switching to a remote instance unmounts it. Clearing the override here
    // dropped a branch the user had already picked for the repository the
    // parent still had selected; the new-session screen owns that clear
    // (`useNewSessionBranchOverrideScope`).
    const renderer = mountSection({ value: 'github:owner/repo' });
    setSelectedBranchOverride(githubRow, 'release/2.0');

    act(() => {
      renderer.unmount();
    });

    expect(getSelectedBranchOverride(githubRow)).toBe('release/2.0');
  });

  it('hands the branch selector the screen organization scope', () => {
    const renderer = mountSection({ value: 'github:owner/repo', organizationId: 'org-2' });

    expect(branchSelectorProps(renderer).organizationId).toBe('org-2');
  });
});

describe('NewSessionRepositorySection Bitbucket connect card', () => {
  it('states outright that Bitbucket is organizations-only', () => {
    const renderer = mountSection({
      groups: [group('github', 'repos'), group('gitlab', 'repos'), group('bitbucket', 'connect')],
    });

    expect(renderedText(renderer)).toContain(
      i18n.t('agentChat.newSession.bitbucketOrganizationsOnly')
    );
  });

  it('leaves the GitHub connect card free of the Bitbucket restriction', () => {
    const renderer = mountSection({
      groups: [group('github', 'connect'), group('gitlab', 'repos')],
    });

    expect(renderedText(renderer)).not.toContain(
      i18n.t('agentChat.newSession.bitbucketOrganizationsOnly')
    );
  });
});
