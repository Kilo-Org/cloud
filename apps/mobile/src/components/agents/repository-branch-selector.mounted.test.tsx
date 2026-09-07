/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { RepositoryBranchSelector } from './repository-branch-selector';
import {
  getSelectedBranchOverride,
  type NewSessionRepository,
  resetSelectedBranchOverrides,
  setSelectedBranchOverride,
} from './new-session-repository-state';
import { type RepositoryBranchesState, useRepositoryBranches } from '@/lib/use-new-session-repos';

vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    View: 'View',
    Modal: 'Modal',
    Pressable: 'Pressable',
    // The real FlatList virtualizes; the fake renders every row so the picker's
    // rows are assertable.
    FlatList: ({
      data,
      renderItem,
      keyExtractor,
    }: {
      data: string[];
      renderItem: (info: { item: string }) => React.ReactNode;
      keyExtractor: (item: string) => string;
    }) =>
      React.createElement(
        'FlatList',
        {},
        ...data.map(item =>
          React.createElement('FlatListRow', { key: keyExtractor(item) }, renderItem({ item }))
        )
      ),
  };
});
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check', ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#777777' }),
}));
vi.mock('@/lib/use-new-session-repos', () => ({ useRepositoryBranches: vi.fn() }));

const githubRow: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
const bitbucketRow: NewSessionRepository = {
  platform: 'bitbucket',
  fullName: 'team/repo',
  isPrivate: true,
  workspaceUuid: 'ws-1',
  repositoryUuid: 'id-1',
};

const retry = vi.fn(() => undefined);

function branchesState(overrides: Partial<RepositoryBranchesState> = {}): RepositoryBranchesState {
  return {
    defaultBranch: 'main',
    branches: ['main', 'release/2.0'],
    isEnabled: true,
    isLoading: false,
    isRetryableError: false,
    isPermanentError: false,
    isRetrying: false,
    retry,
    ...overrides,
  };
}

function mountSelector(
  repository: NewSessionRepository | null,
  state: RepositoryBranchesState = branchesState(),
  disabled = false
) {
  vi.mocked(useRepositoryBranches).mockReturnValue(state);
  const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    renderer.current = TestRenderer.create(
      createElement(RepositoryBranchSelector, { repository, disabled })
    );
  });
  const created = renderer.current;
  if (created === null) {
    throw new Error('the branch selector did not render');
  }
  return created;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

function pressableWithLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function'
  )[0];
}

function branchLabel(branch: string): string {
  return i18n.t('agentChat.newSession.branchAccessibility', { label: branch });
}

/** Fire a node's `onPress`, the way a tap would. */
function press(node: TestRenderer.ReactTestInstance | undefined) {
  act(() => {
    (node?.props.onPress as (() => void) | undefined)?.();
  });
}

function openPicker(renderer: TestRenderer.ReactTestRenderer, selected: string) {
  press(pressableWithLabel(renderer, branchLabel(selected)));
}

/** The picker's row for a branch — the trigger row carries the same label. */
function pickerRow(renderer: TestRenderer.ReactTestRenderer, branch: string) {
  return renderer.root
    .findAll(
      node =>
        node.props.accessibilityLabel === branchLabel(branch) &&
        typeof node.props.onPress === 'function'
    )
    .at(-1);
}

beforeEach(() => {
  // Silences React's "environment is not configured to support act(...)"
  // warning, the same way the other mounted suites do.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  resetSelectedBranchOverrides();
});

describe('RepositoryBranchSelector', () => {
  it('renders nothing until a repository is selected', () => {
    const renderer = mountSelector(null);

    expect(renderer.toJSON()).toBeNull();
  });

  it('preselects the provider default and marks it', () => {
    const renderer = mountSelector(githubRow);

    expect(pressableWithLabel(renderer, branchLabel('main'))).toBeDefined();
    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.branchDefault'));
  });

  it('records a non-default choice for exactly this repository', () => {
    const renderer = mountSelector(githubRow);
    openPicker(renderer, 'main');

    press(pickerRow(renderer, 'release/2.0'));

    expect(getSelectedBranchOverride(githubRow)).toBe('release/2.0');
    expect(getSelectedBranchOverride({ ...githubRow, platform: 'gitlab' })).toBeNull();
  });

  it('drops the override when the default branch is picked again', () => {
    setSelectedBranchOverride(githubRow, 'release/2.0');
    const renderer = mountSelector(githubRow);
    openPicker(renderer, 'release/2.0');

    press(pickerRow(renderer, 'main'));

    expect(getSelectedBranchOverride(githubRow)).toBeNull();
  });

  it('reserves the row height while branches load, so nothing jumps', () => {
    const loading = mountSelector(githubRow, branchesState({ isLoading: true }));
    const skeleton = loading.root.findAllByType('Skeleton' as never)[0];

    expect(skeleton?.props.className).toContain('h-12');
    expect(
      loading.root.findAll(
        node => node.props.accessibilityLabel === i18n.t('agentChat.newSession.branchLoading')
      )
    ).not.toHaveLength(0);

    const loaded = mountSelector(githubRow);
    expect(pressableWithLabel(loaded, branchLabel('main'))?.props.className).toContain('h-12');
  });

  it('offers a retry for a transient failure', () => {
    const renderer = mountSelector(githubRow, branchesState({ isRetryableError: true }));

    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.branchLoadError'));
    press(renderer.root.findAllByType('Button' as never)[0]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('explains a refusal a retry cannot fix, with no retry', () => {
    const renderer = mountSelector(githubRow, branchesState({ isPermanentError: true }));

    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.branchUnavailable'));
    expect(renderer.root.findAllByType('Button' as never)).toHaveLength(0);
  });

  it('explains the organizations-only restriction for a personal Bitbucket row', () => {
    const renderer = mountSelector(
      bitbucketRow,
      branchesState({ isEnabled: false, branches: [], defaultBranch: null })
    );

    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.bitbucketOrganizationsOnly'));
    expect(renderer.root.findAllByType('Button' as never)).toHaveLength(0);
  });

  it('offers no override for a repository with no branches', () => {
    const renderer = mountSelector(githubRow, branchesState({ branches: [], defaultBranch: null }));

    expect(texts(renderer)).toContain(i18n.t('agentChat.newSession.branchEmpty'));
    expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
    expect(getSelectedBranchOverride(githubRow)).toBeNull();
  });

  it('invites a choice when the provider names no default branch', () => {
    const renderer = mountSelector(
      githubRow,
      branchesState({ defaultBranch: null, branches: ['trunk', 'release/2.0'] })
    );
    const placeholder = i18n.t('agentChat.newSession.branchPlaceholder');

    // The picker lists both branches, so the row must not claim the list is
    // empty — and nothing is marked as the provider default.
    expect(texts(renderer)).toContain(placeholder);
    expect(texts(renderer)).not.toContain(i18n.t('agentChat.newSession.branchEmpty'));
    expect(texts(renderer)).not.toContain(i18n.t('agentChat.newSession.branchDefault'));

    openPicker(renderer, placeholder);
    press(pickerRow(renderer, 'trunk'));

    expect(getSelectedBranchOverride(githubRow)).toBe('trunk');
  });

  it('marks the row disabled while the session is being created', () => {
    const renderer = mountSelector(githubRow, branchesState(), true);
    const trigger = pressableWithLabel(renderer, branchLabel('main'));

    // RN blocks the press itself; the row has to say so to VoiceOver too.
    expect(trigger?.props.disabled).toBe(true);
    expect(trigger?.props.accessibilityState).toEqual({ disabled: true });
    expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
  });
});
