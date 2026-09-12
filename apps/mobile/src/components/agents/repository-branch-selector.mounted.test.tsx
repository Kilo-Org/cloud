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
import { branchPickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';

const router = vi.hoisted(() => ({ push: vi.fn() }));
const keyboard = vi.hoisted(() => ({ dismiss: vi.fn() }));

vi.mock('expo-router', () => ({
  useRouter: () => router,
  // The selector only builds an href literal; Href stays a type.
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  return {
    View: 'View',
    Pressable: 'Pressable',
    Keyboard: keyboard,
    // The real ScrollView scrolls; the fake renders every row so a picker's
    // rows are assertable.
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('ScrollView', {}, children),
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

beforeEach(() => {
  // Silences React's "environment is not configured to support act(...)"
  // warning, the same way the other mounted suites do.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  resetSelectedBranchOverrides();
  branchPickerSlot.clear(UNFENCED_ROUTE_KEY);
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

  it('opens the standard picker route, publishing the branches to the slot', () => {
    const renderer = mountSelector(githubRow);

    openPicker(renderer, 'main');

    const bridge = branchPickerSlot.get(UNFENCED_ROUTE_KEY);
    expect(bridge?.branches).toEqual(['main', 'release/2.0']);
    expect(bridge?.defaultBranch).toBe('main');
    expect(bridge?.selectedBranch).toBe('main');
    expect(router.push).toHaveBeenCalledWith('/(app)/agent-chat/branch-picker');
  });

  it('dismisses the keyboard when the picker opens', () => {
    const renderer = mountSelector(githubRow);

    openPicker(renderer, 'main');

    expect(keyboard.dismiss).toHaveBeenCalled();
  });

  it('records a non-default choice for exactly this repository', () => {
    const renderer = mountSelector(githubRow);
    openPicker(renderer, 'main');

    act(() => {
      branchPickerSlot.get(UNFENCED_ROUTE_KEY)?.onSelect('release/2.0');
    });

    expect(getSelectedBranchOverride(githubRow)).toBe('release/2.0');
    expect(getSelectedBranchOverride({ ...githubRow, platform: 'gitlab' })).toBeNull();
  });

  it('drops the override when the default branch is picked again', () => {
    setSelectedBranchOverride(githubRow, 'release/2.0');
    const renderer = mountSelector(githubRow);
    openPicker(renderer, 'release/2.0');

    act(() => {
      branchPickerSlot.get(UNFENCED_ROUTE_KEY)?.onSelect('main');
    });

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

  // Spot check e4-branch-03/04: the screenshots showed a blue "refreshing"
  // overlay floating over the prompt card and over the screen header while
  // branches loaded. That overlay belonged to the old inline picker; the row
  // is now an in-flow fixed-height row and the picker is its own opaque
  // formSheet route. These two tests pin the replacement: the row never
  // carries an absolute-positioned node in any state (nothing can cover the
  // card above or the header), and the three fixed states share one height.
  it('renders every branch-row state in-flow — no node overlays the form', () => {
    const states: RepositoryBranchesState[] = [
      branchesState({ isLoading: true }),
      branchesState(),
      branchesState({ isRetryableError: true }),
      branchesState({ isPermanentError: true }),
      branchesState({ branches: [], defaultBranch: null }),
      branchesState({ isEnabled: false }),
    ];
    for (const state of states) {
      const renderer = mountSelector(githubRow, state);
      const floating = renderer.root.findAll(node => {
        const classes =
          typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
        const style = node.props.style as { position?: string } | undefined;
        return classes.includes('absolute') || style?.position === 'absolute';
      });
      expect(floating).toHaveLength(0);
    }
  });

  it('keeps skeleton, trigger, and error row at the same fixed height', () => {
    for (const state of [
      branchesState({ isLoading: true }),
      branchesState(),
      branchesState({ isRetryableError: true }),
    ]) {
      const renderer = mountSelector(githubRow, state);
      const row = renderer.root.findAll(node => {
        const classes =
          typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
        return classes.includes('h-12');
      });
      expect(row).toHaveLength(1);
    }
  });

  it('shows the branch name and chevron once a retry loads the branches', () => {
    // Spot check e4-retry-loaded: after tapping Retry the row rendered as an
    // empty field — no branch name, no chevron, no skeleton. The loaded
    // trigger carries both.
    const renderer = mountSelector(githubRow, branchesState({ isRetryableError: true }));
    press(renderer.root.findAllByType('Button' as never)[0]);
    expect(retry).toHaveBeenCalledTimes(1);

    vi.mocked(useRepositoryBranches).mockReturnValue(branchesState());
    act(() => {
      renderer.update(
        createElement(RepositoryBranchSelector, { repository: githubRow, disabled: false })
      );
    });

    expect(pressableWithLabel(renderer, branchLabel('main'))).toBeDefined();
    expect(texts(renderer)).toContain('main');
    expect(renderer.root.findAllByType('ChevronDown' as never).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType('Skeleton' as never)).toHaveLength(0);
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

  it('sizes a note row to its full message instead of clipping it', () => {
    // The permanent-failure copy runs past two lines at phone width, so the
    // row must grow with the text: no line cap, and a minimum height rather
    // than the fixed trigger height.
    const renderer = mountSelector(githubRow, branchesState({ isPermanentError: true }));
    const message = i18n.t('agentChat.newSession.branchUnavailable');

    const note = renderer.root.findAll(
      node => node.type === ('Text' as never) && node.children.includes(message)
    )[0];
    if (note === undefined) {
      throw new Error('the permanent-failure note did not render');
    }
    expect(note.props.numberOfLines).toBeUndefined();

    const row = note.parent;
    if (row === null) {
      throw new Error('the permanent-failure note rendered without a row');
    }
    const classes = (row.props.className as string).split(' ');
    expect(classes).toContain('min-h-12');
    expect(classes).not.toContain('h-12');
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
    expect(branchPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
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

    const bridge = branchPickerSlot.get(UNFENCED_ROUTE_KEY);
    expect(bridge?.selectedBranch).toBeNull();
    act(() => {
      bridge?.onSelect('trunk');
    });
    expect(getSelectedBranchOverride(githubRow)).toBe('trunk');
  });

  it('marks the row disabled while the session is being created', () => {
    const renderer = mountSelector(githubRow, branchesState(), true);
    const trigger = pressableWithLabel(renderer, branchLabel('main'));

    // RN blocks the press itself; the row has to say so to VoiceOver too.
    expect(trigger?.props.disabled).toBe(true);
    expect(trigger?.props.accessibilityState).toEqual({ disabled: true });
    press(trigger);
    expect(router.push).not.toHaveBeenCalled();
    expect(branchPickerSlot.get(UNFENCED_ROUTE_KEY)).toBeUndefined();
  });
});

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}
