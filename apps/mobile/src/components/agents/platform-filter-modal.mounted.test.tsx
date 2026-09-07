import { act, type ComponentProps } from 'react';
import { Modal, Pressable, ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type AgentSessionFilters } from '@/lib/agent-session-filters';
import { emitPrivacyCover } from '@/lib/privacy-cover-events';
import { renderWithProviders } from '@/test/render-with-providers';
import { SessionFilterModal } from './platform-filter-modal';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primaryForeground: '#1a1a10' }),
}));

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
  return { renderer: view.renderer, props };
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

describe('SessionFilterModal', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  it.each(['cancel', 'backdrop', 'native', 'privacy'] as const)(
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
          if (dismissal === 'privacy') {
            emitPrivacyCover();
          } else if (dismissal === 'native') {
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
});
