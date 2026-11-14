/* eslint-disable max-lines -- the suite renders every selector state, each with its own assertion set */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
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
import {
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
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
    truncated: false,
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
      createElement(RepositoryBranchSelector, { repository, organizationId: undefined, disabled })
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

/** The class list a node renders, split into single class names. */
function classesOf(node: TestRenderer.ReactTestInstance | undefined): string[] {
  const className: unknown = node?.props.className;
  return typeof className === 'string' ? className.split(' ') : [];
}

/** Nodes whose class list holds `className` as one class, not as a substring. */
function rowsWithClass(renderer: TestRenderer.ReactTestRenderer, className: string) {
  return renderer.root.findAll(node => classesOf(node).includes(className));
}

/** The bordered frame every branch-row state draws, whatever it holds. */
function rowFrame(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      classesOf(node).includes('rounded-lg') &&
      classesOf(node).includes('border') &&
      classesOf(node).includes('px-3')
  )[0];
}

/**
 * The body inside {@link rowFrame}: the box the row's height comes from. It is
 * borderless on every state, so its floor is its exact height and the frame's
 * border is the only thing the states add around it.
 */
function rowBody(renderer: TestRenderer.ReactTestRenderer) {
  return rowFrame(renderer)?.children[0] as TestRenderer.ReactTestInstance | undefined;
}

/** The class names of the shared trigger body, for a body that must render it. */
const TRIGGER_BODY_CLASSES = FIELD_TRIGGER_BODY_CLASS.split(' ');

/** Classes that pin a node's own height — none may sit on a row frame. */
function heightClasses(node: TestRenderer.ReactTestInstance | undefined): string[] {
  return classesOf(node).filter(name => /^-?(min-)?h-/.test(name));
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
    expect(bridge?.truncated).toBe(false);
    expect(router.push).toHaveBeenCalledWith('/(app)/agent-chat/branch-picker');
  });

  it('says the branch list is incomplete and publishes the flag to the picker', () => {
    const partialNote = i18n.t('agentChat.newSession.branchListIncomplete');
    const renderer = mountSelector(githubRow, branchesState({ truncated: true }));

    expect(texts(renderer)).toContain(partialNote);

    // The note sits under a live trigger, so it is helper text with no frame of
    // its own: a second bordered `bg-secondary` box there read as another,
    // broken picker sitting 8 dp below the real one. Exactly one node may draw
    // the trigger frame and its 48 dp body.
    expect(rowsWithClass(renderer, 'bg-secondary')).toHaveLength(1);
    expect(rowsWithClass(renderer, 'min-h-[48px]')).toHaveLength(1);

    openPicker(renderer, 'main');

    expect(branchPickerSlot.get(UNFENCED_ROUTE_KEY)?.truncated).toBe(true);
  });

  it('shows no partial-listing note for a complete list', () => {
    const renderer = mountSelector(githubRow);

    expect(texts(renderer)).not.toContain(i18n.t('agentChat.newSession.branchListIncomplete'));
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
    // The shift this pins: the loading row was a bare 48 dp skeleton while the
    // rows it became drew their own 1 dp border around the same content, so
    // everything below the row moved by that border when branches arrived.
    const loading = mountSelector(githubRow, branchesState({ isLoading: true }));

    expect(heightClasses(rowFrame(loading))).toHaveLength(0);
    expect(classesOf(rowBody(loading))).toContain('min-h-[48px]');
    expect(
      loading.root.findAll(
        node => node.props.accessibilityLabel === i18n.t('agentChat.newSession.branchLoading')
      )
    ).not.toHaveLength(0);

    // `--skeleton-fill` equals `--secondary` in the light palette, so a default
    // bar on this row's own `bg-secondary` fill painted nothing and the loading
    // state read as an empty field. The bar takes `bg-muted-soft`, and `w-1/3`
    // sizes it as a branch name rather than a progress bar.
    const bar = loading.root.findAllByType('Skeleton' as never)[0];
    expect(classesOf(bar)).toEqual(expect.arrayContaining(['h-4', 'w-1/3', 'bg-muted-soft']));
    expect(classesOf(bar)).not.toContain('bg-skeleton-fill');

    const loaded = mountSelector(githubRow);
    expect(rowFrame(loaded)?.props.accessibilityLabel).toBe(branchLabel('main'));
    expect(heightClasses(rowFrame(loaded))).toHaveLength(0);
    expect(classesOf(rowBody(loaded))).toContain('min-h-[48px]');
  });

  // Spot check e4-branch-03/04: the screenshots showed a blue "refreshing"
  // overlay floating over the prompt card and over the screen header while
  // branches loaded. That overlay belonged to the old inline picker; the row
  // is now an in-flow row on the shared 48 px floor and the picker is its own
  // opaque formSheet route. These two tests pin the replacement: the row never
  // carries an absolute-positioned node in any state (nothing can cover the
  // card above or the header), and the three fixed states share one floor.
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

  it('keeps every state on one frame around the shared row target', () => {
    const states: RepositoryBranchesState[] = [
      branchesState({ isLoading: true }),
      branchesState(),
      branchesState({ isRetryableError: true }),
    ];
    for (const state of states) {
      const renderer = mountSelector(githubRow, state);
      // The frame never pins a height: a floor read against a border box makes
      // the states whose content is already 48 dp tall taller than the rest.
      expect(heightClasses(rowFrame(renderer))).toHaveLength(0);
      expect(classesOf(rowBody(renderer))).toContain('min-h-[48px]');
      expect(rowsWithClass(renderer, 'h-12')).toHaveLength(0);
    }
  });

  it('draws the loading, loaded and failed rows on the same frame chrome', () => {
    // Same border and padding on every state, so the only difference between
    // the three boxes is their background — and a background never moves a row.
    const chrome = (state: RepositoryBranchesState) =>
      classesOf(rowFrame(mountSelector(githubRow, state))).filter(name => !name.startsWith('bg-'));
    const loading = chrome(branchesState({ isLoading: true }));

    expect(chrome(branchesState())).toEqual(loading);
    expect(chrome(branchesState({ isRetryableError: true }))).toEqual(loading);
  });

  it('gives the failed row a body tall enough for its retry action', () => {
    // At this app's 14 pt rem a fixed `h-12` row rendered 42 pt — 6 pt shorter
    // than the 48 dp retry action before the row's own 1 dp borders — so the
    // row clipped the action. The action now sits inside the row's 48 dp body,
    // and the row's border is the only thing the frame adds around it.
    const renderer = mountSelector(githubRow, branchesState({ isRetryableError: true }));
    const body = rowBody(renderer);

    expect(classesOf(body)).toContain('min-h-[48px]');
    expect(body?.findAllByType('Button' as never)).toHaveLength(1);

    const [retryAction] = renderer.root.findAllByType('Button' as never);
    expect(classesOf(retryAction)).toContain(STATE_ACTION_CLASS);
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
        createElement(RepositoryBranchSelector, {
          repository: githubRow,
          organizationId: undefined,
          disabled: false,
        })
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
    expect(classesOf(row)).toContain('min-h-[48px]');
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

  it('renders every state in the same trigger frame as the pickers above it', () => {
    // The finding this pins: the branch row measured ~50.3 dp while the
    // Account, Run on and Repository triggers above it measured ~44.2 dp, so
    // the last control in the column read as a differently sized field, and
    // the failed and note states swapped the frame's fill for a card.
    const states: RepositoryBranchesState[] = [
      branchesState({ isLoading: true }),
      branchesState(),
      branchesState({ isRetryableError: true }),
      branchesState({ isPermanentError: true }),
      branchesState({ branches: [], defaultBranch: null }),
      branchesState({ isEnabled: false }),
    ];
    const triggerFrame = FIELD_TRIGGER_FRAME_CLASS.split(' ').sort();
    for (const state of states) {
      const renderer = mountSelector(githubRow, state);
      expect(classesOf(rowFrame(renderer)).sort()).toEqual(triggerFrame);
      expect(classesOf(rowBody(renderer))).toEqual(expect.arrayContaining(TRIGGER_BODY_CLASSES));
      // One fill for every state, and it is the shared trigger's own.
      expect(classesOf(rowFrame(renderer)).filter(name => name.startsWith('bg-'))).toEqual([
        'bg-secondary',
      ]);
    }
  });

  it("starts a note row at the frame's leading inset, like the failed message", () => {
    // A note is a line of copy inside a field, so it reads from the leading
    // edge: the shared body lays its row out at the start, and only the
    // loading line fills the width (its skeleton does).
    const renderer = mountSelector(githubRow, branchesState({ isPermanentError: true }));

    expect(classesOf(rowBody(renderer))).toEqual(expect.arrayContaining(TRIGGER_BODY_CLASSES));
    expect(classesOf(rowBody(renderer))).not.toContain('justify-center');
    expect(classesOf(rowBody(renderer))).not.toContain('justify-between');
  });

  it('keeps a multi-line note off the frame border', () => {
    // A note keeps the 48 dp floor, but its copy can outgrow it: the
    // permanent-refusal message runs past two lines at phone width, and longer
    // translations of the truncated-list note do too. At three `text-sm` lines
    // `items-center` has no slack left, so without the body's own vertical
    // padding the first and last line boxes would sit on the frame's 1 dp
    // border — the inset would collapse exactly for the long copy the row
    // exists to show.
    const renderer = mountSelector(githubRow, branchesState({ isPermanentError: true }));

    expect(classesOf(rowBody(renderer))).toContain('py-2');
    // The floor stays, so a one-line note is still exactly one trigger tall.
    expect(classesOf(rowBody(renderer))).toContain('min-h-[48px]');
    // The trigger's body never carries it: the value line is centred in slack.
    const loaded = mountSelector(githubRow);
    expect(classesOf(rowBody(loaded))).not.toContain('py-2');
  });

  it('keeps a two-line retry message off the frame border without growing the row', () => {
    // The message is two lines of `text-sm` that scales with the system font,
    // so at large sizes it outgrows the 48 dp floor. The padding goes on the
    // message: on the body it would add to the 48 dp retry and make the failed
    // row taller than every other branch state.
    const renderer = mountSelector(githubRow, branchesState({ isRetryableError: true }));

    expect(classesOf(rowBody(renderer))).not.toContain('py-2');
    const message = renderer.root.findAll(
      node => node.props.numberOfLines === 2 && typeof node.props.className === 'string'
    )[0];
    expect(classesOf(message)).toContain('py-2');
  });

  it('draws the retry borderless, on the shared action floor, aligned to the message inset', () => {
    // A box inside the frame drew its own border against the frame's (doubled
    // edges, worst in dark) and sat 10.5 dp in from the trailing border. A
    // borderless action fills the body instead, and its negative trailing
    // margin cancels its own horizontal padding, so the label keeps the same
    // 10.5 dp from the trailing border that the message keeps from the leading
    // one in either direction.
    const renderer = mountSelector(githubRow, branchesState({ isRetryableError: true }));
    const retryAction = renderer.root.findAllByType('Button' as never)[0];
    if (retryAction === undefined) {
      throw new Error('the retry action did not render');
    }

    expect(retryAction.props.variant).toBe('ghost');
    expect(classesOf(retryAction)).toContain(STATE_ACTION_CLASS);
    expect(classesOf(retryAction)).toContain('-me-3');
  });
});

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}
