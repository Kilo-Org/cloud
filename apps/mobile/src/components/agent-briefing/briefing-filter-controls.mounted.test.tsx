import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { FilterChip } from '@/components/ui/filter-chip';

import { BriefingFilterControls } from './briefing-filter-controls';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

const ORGANIZATIONS = [{ organizationId: 'org_labs', organizationName: 'Labs' }];

type FiltersProps = {
  history: boolean;
  organizationId: string | null | undefined;
};

function renderFilters(props: FiltersProps) {
  return createElement(BriefingFilterControls, {
    ...props,
    organizations: ORGANIZATIONS,
    onSelectHistory: () => undefined,
    onSelectOrganization: () => undefined,
  });
}

function isHostType(node: TestRenderer.ReactTestInstance, type: string): boolean {
  return typeof node.type === 'string' && (node.type as string) === type;
}

function optionByText(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const option = root
    .findAll(node => isHostType(node, 'Pressable'))
    .find(node =>
      node.findAll(inner => isHostType(inner, 'Text')).some(text => text.props.children === label)
    );
  if (!option) {
    throw new Error(`Missing option ${label}`);
  }
  return option;
}

function selectedOf(root: TestRenderer.ReactTestInstance, label: string): unknown {
  const state: unknown = optionByText(root, label).props.accessibilityState;
  return typeof state === 'object' && state !== null && 'selected' in state
    ? state.selected
    : undefined;
}

it('names the context chip row as a filter group', () => {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      renderFilters({ history: false, organizationId: undefined })
    );
  });
  const root = holder.renderer;
  if (!root) {
    throw new Error('Controls are not mounted');
  }
  // The view switch is a radio group, so the context row is the tablist and the
  // one whose name says what it filters.
  const groups = root.root
    .findAll(node => node.props.accessibilityRole === 'tablist')
    .filter(node => node.props.accessibilityLabel === 'agentBriefing.filterByContext');
  expect(groups).toHaveLength(1);
  const [group] = groups;
  if (!group) {
    throw new Error('The context chip row is not announced as a group');
  }
  // The row's entries carry the strip-entry role contract too, so the
  // announced role matches the chips' children (the same shape the tabs use).
  const contextChips = group.findAll(node => isHostType(node, 'Pressable'));
  expect(contextChips.length).toBeGreaterThan(0);
  // The all-contexts chip speaks its own copy, not the shared "All". The chip
  // passes `label` to `Button`, which builds the pressable's name from it.
  const allChip = root.root
    .findAllByType(FilterChip)
    .find(chip => chip.props.label === 'agentBriefing.contextAll');
  expect(allChip?.props.selected).toBe(true);
  act(() => {
    holder.renderer?.unmount();
  });
});

it('announces the active briefing view and context filter as selected', () => {
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      renderFilters({ history: false, organizationId: undefined })
    );
  });
  const root = holder.renderer;
  if (!root) {
    throw new Error('Controls are not mounted');
  }
  expect(root.root.findAll(node => node.props.accessibilityRole === 'radiogroup')).toHaveLength(1);
  // The mocked platform is iOS, where a radio entry is typed as a button so
  // VoiceOver gives it a control trait (see lib/a11y/selectable-row).
  for (const label of ['agentBriefing.available', 'agentBriefing.history']) {
    expect(optionByText(root.root, label).props.accessibilityRole).toBe('button');
  }
  expect(selectedOf(root.root, 'agentBriefing.available')).toBe(true);
  expect(selectedOf(root.root, 'agentBriefing.history')).toBe(false);
  expect(selectedOf(root.root, 'agentBriefing.contextAll')).toBe(true);
  expect(selectedOf(root.root, 'common.personal')).toBe(false);
  expect(selectedOf(root.root, 'Labs')).toBe(false);

  act(() => {
    holder.renderer?.update(renderFilters({ history: true, organizationId: null }));
  });
  expect(selectedOf(root.root, 'agentBriefing.available')).toBe(false);
  expect(selectedOf(root.root, 'agentBriefing.history')).toBe(true);
  expect(selectedOf(root.root, 'agentBriefing.contextAll')).toBe(false);
  expect(selectedOf(root.root, 'common.personal')).toBe(true);
  expect(selectedOf(root.root, 'Labs')).toBe(false);

  act(() => {
    holder.renderer?.update(renderFilters({ history: true, organizationId: 'org_labs' }));
  });
  expect(selectedOf(root.root, 'agentBriefing.contextAll')).toBe(false);
  expect(selectedOf(root.root, 'common.personal')).toBe(false);
  expect(selectedOf(root.root, 'Labs')).toBe(true);
});
