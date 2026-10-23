import { createElement } from 'react';
import { expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { BriefingFilterControls } from './briefing-filter-controls';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
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

it('announces the active briefing tab and context filter as selected', () => {
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
  expect(root.root.findAll(node => node.props.accessibilityRole === 'tablist')).toHaveLength(1);
  for (const label of ['agentBriefing.available', 'agentBriefing.history']) {
    expect(optionByText(root.root, label).props.role).toBe('tab');
  }
  expect(selectedOf(root.root, 'agentBriefing.available')).toBe(true);
  expect(selectedOf(root.root, 'agentBriefing.history')).toBe(false);
  expect(selectedOf(root.root, 'common.all')).toBe(true);
  expect(selectedOf(root.root, 'common.personal')).toBe(false);
  expect(selectedOf(root.root, 'Labs')).toBe(false);

  act(() => {
    holder.renderer?.update(renderFilters({ history: true, organizationId: null }));
  });
  expect(selectedOf(root.root, 'agentBriefing.available')).toBe(false);
  expect(selectedOf(root.root, 'agentBriefing.history')).toBe(true);
  expect(selectedOf(root.root, 'common.all')).toBe(false);
  expect(selectedOf(root.root, 'common.personal')).toBe(true);
  expect(selectedOf(root.root, 'Labs')).toBe(false);

  act(() => {
    holder.renderer?.update(renderFilters({ history: true, organizationId: 'org_labs' }));
  });
  expect(selectedOf(root.root, 'common.all')).toBe(false);
  expect(selectedOf(root.root, 'common.personal')).toBe(false);
  expect(selectedOf(root.root, 'Labs')).toBe(true);
});
