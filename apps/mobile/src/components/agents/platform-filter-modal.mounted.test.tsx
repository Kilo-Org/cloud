/* eslint-disable max-lines -- the sheet's rows, window bounds, dismissal paths, and derived-list memoization share one mounted harness */
/* eslint-disable max-lines -- cohesive mounted-test suite for the session filter sheet */
import { act, type ComponentProps } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Modal, Pressable, ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type AgentSessionFilters } from '@/lib/agent-session-filters';
import { renderWithProviders } from '@/test/render-with-providers';
import * as PlatformFilterRows from './platform-filter-rows';
import { SessionFilterModal } from './platform-filter-modal';

let windowDimensions = { width: 400, height: 700, fontScale: 1, scale: 1 };
let insets = { top: 0, bottom: 0, left: 0, right: 0 };

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => windowDimensions,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insets,
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#1a1a10' }),
}));
// Spies around the real derivations: the modal must build them only when the
// props they read change, so the tests count the builds instead of inspecting
// the private memos.
vi.mock('./platform-filter-rows', async importOriginal => {
  const actual = await importOriginal<typeof PlatformFilterRows>();
  return {
    ...actual,
    mergePlatformOptions: vi.fn(actual.mergePlatformOptions),
    buildProjectRows: vi.fn(actual.buildProjectRows),
  };
});

const firstProject = {
  gitUrl: 'https://github.com/iscekic/kilo-workflow.git',
  displayName: 'ISCEKIC/KILO-WORKFLOW',
};
const secondProject = {
  gitUrl: 'https://github.com/Kilo-Org/kilocode.git',
  displayName: 'KILO-ORG/KILOCODE',
};
const projects = [firstProject, secondProject];
const unavailable = 'https://github.com/unavailable/saved-repository.git';
type RenderedView = Awaited<ReturnType<typeof renderWithProviders>>;
const mounted: RenderedView[] = [];

async function renderModal(overrides: Partial<ComponentProps<typeof SessionFilterModal>> = {}) {
  const props = {
    selectedPlatforms: [],
    selectedProjects: [],
    projectOptions: projects,
    onApply: vi.fn<(filters: AgentSessionFilters) => void>(),
    onClose: vi.fn<() => void>(),
    ...overrides,
  };
  const view = await renderWithProviders(<SessionFilterModal {...props} />);
  mounted.push(view);
  return { renderer: view.renderer, queryClient: view.queryClient, props };
}

function findCheckbox(renderer: RenderedView['renderer'], label: string) {
  const checkbox = renderer.root
    .findAllByProps({ accessibilityRole: 'checkbox' })
    .find(row => row.findByType(Text).props.children === label);
  if (!checkbox) {
    throw new Error(`missing checkbox: ${label}`);
  }
  return checkbox;
}

function pressButton(renderer: RenderedView['renderer'], label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find(row => row.findByType(Text).props.children === label);
  if (!button) {
    throw new Error(`missing button: ${label}`);
  }
  act(() => {
    (button.props.onPress as () => void)();
  });
}

function findSheetCard(renderer: RenderedView['renderer']) {
  const card = renderer.root
    .findAllByType(Pressable)
    .find(pressable => String(pressable.props.className).includes('bg-popover'));
  if (!card) {
    throw new Error('missing sheet card');
  }
  return card;
}

/** Project rows only, in render order, so a toggle's reorder would show up. */
function projectRowLabels(renderer: RenderedView['renderer']) {
  return renderer.root
    .findAllByProps({ accessibilityRole: 'checkbox' })
    .map(row => row.findByType(Text).props.children)
    .filter(label => label === firstProject.displayName || label === secondProject.displayName);
}

describe('SessionFilterModal', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    windowDimensions = { width: 400, height: 700, fontScale: 1, scale: 1 };
    insets = { top: 0, bottom: 0, left: 0, right: 0 };
    vi.mocked(PlatformFilterRows.mergePlatformOptions).mockClear();
    vi.mocked(PlatformFilterRows.buildProjectRows).mockClear();
  });

  afterEach(() => {
    for (const view of mounted) {
      view.unmount();
    }
    mounted.length = 0;
  });

  it('renders the default options with the current selections checked', async () => {
    const { renderer } = await renderModal({
      selectedPlatforms: ['cloud-agent'],
      selectedProjects: [firstProject.gitUrl],
    });
    expect(renderer.root.findByType(Modal).props.visible).toBe(true);
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(renderer.root.findByType(ScrollView).props.horizontal).toBeUndefined();
    const checkboxes = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' });
    expect(checkboxes.map(row => row.findByType(Text).props.children)).toEqual([
      i18n.t('agentChat.sessionFilter.platformCloud'),
      i18n.t('agentChat.sessionFilter.platformExtension'),
      i18n.t('agentChat.sessionFilter.platformCli'),
      i18n.t('agentChat.sessionFilter.platformSlack'),
      i18n.t('common.github'),
      i18n.t('agentChat.sessionFilter.platformLinear'),
      i18n.t('agentChat.sessionFilter.platformOther'),
      firstProject.displayName,
      secondProject.displayName,
    ]);
    expect(
      checkboxes.map(
        row => (row.props as ComponentProps<typeof Pressable>).accessibilityState?.checked
      )
    ).toEqual([true, false, false, false, false, false, false, true, false]);
  });

  it('caps the sheet to the window and keeps the action row out of the option list', async () => {
    const { renderer } = await renderModal();
    const card = findSheetCard(renderer);
    expect(card.props.style).toMatchObject({ maxHeight: 700 - 48 });
    const options = renderer.root.findByType(ScrollView);
    expect(String(options.props.className)).toContain('shrink');
    expect(options.findAllByType(Button)).toHaveLength(0);
    expect(renderer.root.findAllByType(Button)).toHaveLength(2);
  });

  it('reserves the safe-area insets inside the window cap', async () => {
    insets = { top: 47, bottom: 34, left: 0, right: 0 };
    const { renderer } = await renderModal();
    expect(findSheetCard(renderer).props.style).toMatchObject({
      maxHeight: 700 - 47 - 34 - 48,
    });
  });

  it('uses the supplied platform options and omits an empty project section', async () => {
    const { renderer } = await renderModal({
      platformOptions: ['cli', 'future-platform'],
      selectedPlatforms: ['future-platform'],
      projectOptions: [],
    });
    const checkboxes = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' });
    expect(checkboxes.map(row => row.findByType(Text).props.children)).toEqual([
      i18n.t('agentChat.sessionFilter.platformCli'),
      'FUTURE-PLATFORM',
    ]);
    expect(
      checkboxes.map(
        row => (row.props as ComponentProps<typeof Pressable>).accessibilityState?.checked
      )
    ).toEqual([false, true]);
    expect(renderer.root.findAllByType(Text).map(text => text.props.children)).not.toContain(
      i18n.t('agentChat.sessionFilter.project')
    );
  });

  it('commits both draft arrays only on Apply and preserves unavailable selections', async () => {
    const selectedPlatforms = ['cli', 'future-platform'];
    const selectedProjects = [firstProject.gitUrl, unavailable];
    const { renderer, props } = await renderModal({ selectedPlatforms, selectedProjects });
    const changes = [
      { label: firstProject.displayName, checked: false },
      { label: secondProject.displayName, checked: true },
      { label: i18n.t('agentChat.sessionFilter.platformCloud'), checked: true },
      { label: i18n.t('agentChat.sessionFilter.platformCli'), checked: false },
    ];
    for (const change of changes) {
      act(() => {
        (findCheckbox(renderer, change.label).props.onPress as () => void)();
      });
      expect(findCheckbox(renderer, change.label).props.accessibilityState).toEqual({
        checked: change.checked,
      });
    }
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(selectedPlatforms).toEqual(['cli', 'future-platform']);
    expect(selectedProjects).toEqual([firstProject.gitUrl, unavailable]);

    pressButton(renderer, i18n.t('common.apply'));

    expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
      platformFilter: ['future-platform', 'cloud-agent'],
      projectFilter: [unavailable, secondProject.gitUrl],
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'other live sessions', platformOptions: ['cli'], projectOptions: [firstProject] },
    { name: 'no live sessions', platformOptions: [], projectOptions: [] },
  ])('lets users remove unavailable saved filters with $name', async options => {
    const { renderer, props } = await renderModal({
      platformOptions: options.platformOptions,
      projectOptions: options.projectOptions,
      selectedPlatforms: ['cli', 'cloud-agent'],
      selectedProjects: [firstProject.gitUrl, unavailable],
    });
    const checkboxes = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' });
    expect(checkboxes).toHaveLength(4);
    expect(new Set(checkboxes.map(row => row.findByType(Text).props.children)).size).toBe(4);

    for (const label of [
      i18n.t('agentChat.sessionFilter.platformCloud'),
      'unavailable/saved-repository',
    ]) {
      expect(findCheckbox(renderer, label).props.accessibilityState).toEqual({ checked: true });
      act(() => {
        (findCheckbox(renderer, label).props.onPress as () => void)();
      });
      expect(findCheckbox(renderer, label).props.accessibilityState).toEqual({ checked: false });
    }

    expect(props.onApply).not.toHaveBeenCalled();
    pressButton(renderer, i18n.t('common.apply'));
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
      platformFilter: ['cli'],
      projectFilter: [firstProject.gitUrl],
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('renders one platform row per bucket and collapses a persisted variant', async () => {
    const { renderer } = await renderModal({
      platformOptions: ['cloud-agent', 'extension'],
      selectedPlatforms: ['cloud-agent-web', 'vscode'],
      projectOptions: [],
    });
    const checkboxes = renderer.root.findAllByProps({ accessibilityRole: 'checkbox' });
    expect(checkboxes.map(row => row.findByType(Text).props.children)).toEqual([
      i18n.t('agentChat.sessionFilter.platformCloud'),
      i18n.t('agentChat.sessionFilter.platformExtension'),
    ]);
    expect(
      checkboxes.map(
        row => (row.props as ComponentProps<typeof Pressable>).accessibilityState?.checked
      )
    ).toEqual([true, true]);
  });

  it('renders one project row per visible label and stores every alias on toggle', async () => {
    const sshAlias = {
      gitUrl: 'git@github.com:iscekic/kilo-workflow.git',
      displayName: 'ISCEKIC/KILO-WORKFLOW',
    };
    const { renderer, props } = await renderModal({
      projectOptions: [firstProject, sshAlias, secondProject],
      selectedProjects: [],
    });
    const labels = renderer.root
      .findAllByProps({ accessibilityRole: 'checkbox' })
      .map(row => row.findByType(Text).props.children);
    expect(labels.filter(label => label === firstProject.displayName)).toHaveLength(1);
    expect(findCheckbox(renderer, firstProject.displayName).props.accessibilityState).toEqual({
      checked: false,
    });

    act(() => {
      (findCheckbox(renderer, firstProject.displayName).props.onPress as () => void)();
    });
    expect(findCheckbox(renderer, firstProject.displayName).props.accessibilityState).toEqual({
      checked: true,
    });

    pressButton(renderer, i18n.t('common.apply'));
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
      platformFilter: [],
      projectFilter: [firstProject.gitUrl, sshAlias.gitUrl],
    });
  });

  it('toggles off every alias of a merged project when any is stored', async () => {
    const sshAlias = {
      gitUrl: 'git@github.com:iscekic/kilo-workflow.git',
      displayName: 'ISCEKIC/KILO-WORKFLOW',
    };
    const { renderer, props } = await renderModal({
      projectOptions: [firstProject, sshAlias, secondProject],
      selectedProjects: [sshAlias.gitUrl],
    });
    expect(findCheckbox(renderer, firstProject.displayName).props.accessibilityState).toEqual({
      checked: true,
    });

    act(() => {
      (findCheckbox(renderer, firstProject.displayName).props.onPress as () => void)();
    });
    expect(findCheckbox(renderer, firstProject.displayName).props.accessibilityState).toEqual({
      checked: false,
    });

    pressButton(renderer, i18n.t('common.apply'));
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
      platformFilter: [],
      projectFilter: [],
    });
  });

  it('applies empty filters after deselecting both dimensions', async () => {
    const { renderer, props } = await renderModal({
      selectedPlatforms: ['cli'],
      selectedProjects: [firstProject.gitUrl],
    });
    for (const label of [firstProject.displayName, i18n.t('agentChat.sessionFilter.platformCli')]) {
      act(() => {
        (findCheckbox(renderer, label).props.onPress as () => void)();
      });
    }
    expect(
      renderer.root
        .findAllByProps({ accessibilityRole: 'checkbox' })
        .every(
          row =>
            (row.props as ComponentProps<typeof Pressable>).accessibilityState?.checked === false
        )
    ).toBe(true);
    pressButton(renderer, i18n.t('common.apply'));
    expect(props.onApply).toHaveBeenCalledExactlyOnceWith({
      platformFilter: [],
      projectFilter: [],
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'backdrop', 'native'] as const)(
    'dismisses through %s without applying draft selections',
    async dismissal => {
      const { renderer, props } = await renderModal();
      act(() => {
        (findCheckbox(renderer, firstProject.displayName).props.onPress as () => void)();
      });
      if (dismissal === 'cancel') {
        pressButton(renderer, i18n.t('common.cancel'));
      } else {
        act(() => {
          if (dismissal === 'native') {
            (renderer.root.findByType(Modal).props.onRequestClose as () => void)();
          } else {
            const backdrop = renderer.root.findAllByType(Pressable)[0];
            if (!backdrop) {
              throw new Error('missing backdrop');
            }
            expect(backdrop.props.accessible).toBe(false);
            (backdrop.props.onPress as () => void)();
          }
        });
      }
      expect(props.onClose).toHaveBeenCalledOnce();
      expect(props.onApply).not.toHaveBeenCalled();
    }
  );

  // The sheet offers one row per recent repository (up to the server's LIMIT)
  // plus one per selected project. A long list must not push the Apply/Cancel
  // row off-screen: the sheet is bounded and its single list shrinks to scroll.
  it('bounds the sheet and shrinks its single list so extra project rows stay reachable', async () => {
    const { renderer } = await renderModal();
    const scrollViews = renderer.root.findAllByType(ScrollView);
    expect(scrollViews).toHaveLength(1);
    const scrollView = renderer.root.findByType(ScrollView);
    expect(scrollView.props.className).toContain('shrink');
    expect(scrollView.parent?.props.className).toContain('max-h-[80%]');
  });

  // The sheet re-derives its rows only when the props they read change. A
  // re-render with unchanged props must hand the list the same platform array
  // identity, so no mounted platform row re-renders.
  it('hands the list the same merged platform array identity on an unchanged re-render', async () => {
    const platformOptions = ['cli', 'future-platform'];
    const { renderer, queryClient, props } = await renderModal({
      platformOptions,
      selectedPlatforms: ['future-platform'],
    });
    const merge = vi.mocked(PlatformFilterRows.mergePlatformOptions);
    expect(merge).toHaveBeenCalledTimes(1);
    const labelsBefore = renderer.root
      .findAllByProps({ accessibilityRole: 'checkbox' })
      .map(row => row.findByType(Text).props.children);

    act(() => {
      renderer.update(
        <QueryClientProvider client={queryClient}>
          <SessionFilterModal {...props} />
        </QueryClientProvider>
      );
    });

    // The merge derivation is memoized on its props, so an unchanged re-render
    // must not run it again: that is what keeps the list's array identity (and
    // therefore every mounted row) stable. The labels stay put as a result.
    expect(merge).toHaveBeenCalledTimes(1);
    expect(
      renderer.root
        .findAllByProps({ accessibilityRole: 'checkbox' })
        .map(row => row.findByType(Text).props.children)
    ).toEqual(labelsBefore);
  });

  // A checkbox toggle changes the draft selection only. The memoized rows are
  // keyed on the props, so toggling must neither rebuild the project map nor
  // reorder the rows: the selected project keeps its (first) row.
  it('keeps the selected project sorting first after toggling another project checkbox', async () => {
    const { renderer } = await renderModal({
      selectedProjects: [firstProject.gitUrl],
      projectOptions: [firstProject, secondProject],
    });
    const build = vi.mocked(PlatformFilterRows.buildProjectRows);
    expect(build).toHaveBeenCalledTimes(1);
    expect(projectRowLabels(renderer)).toEqual([
      firstProject.displayName,
      secondProject.displayName,
    ]);

    act(() => {
      (findCheckbox(renderer, secondProject.displayName).props.onPress as () => void)();
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(projectRowLabels(renderer)).toEqual([
      firstProject.displayName,
      secondProject.displayName,
    ]);
    expect(findCheckbox(renderer, firstProject.displayName).props.accessibilityState).toEqual({
      checked: true,
    });
    expect(findCheckbox(renderer, secondProject.displayName).props.accessibilityState).toEqual({
      checked: true,
    });
  });
});
