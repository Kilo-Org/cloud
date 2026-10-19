// The focus-areas edit screen must show every stored focus area. A stored area
// outside REVIEW_FOCUS_AREAS (focus_areas is z.array(z.string()) at every
// persistence boundary) has no enum row of its own; it renders as a toggleable
// row with the localized fallback label so the user can see and unselect it.

import { createElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import FocusAreasRoute from './focus-areas';
import {
  renderWithProviders,
  waitFor,
  type RenderWithProvidersResult,
} from '@/test/render-with-providers';
const state = vi.hoisted(() => ({
  config: null as unknown,
  cache: null as unknown,
  mutate: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: 'personal', platform: 'github' }),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactElement }) => props.children,
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: () => ({ data: state.config }),
  useReviewConfigCacheReader: () => () => state.cache,
  useSaveReviewConfig: () => ({ mutate: state.mutate }),
}));

beforeEach(() => {
  state.config = null;
  state.cache = null;
  state.mutate = vi.fn();
});

type Mounted = RenderWithProvidersResult;

type ChoiceRowProps = {
  label: string;
  selected: boolean;
  onPress?: () => void;
};

function choiceRows(renderer: Mounted['renderer']): ChoiceRowProps[] {
  return renderer.root
    .findAll(node => String(node.type) === 'ChoiceRow')
    .map(node => node.props as unknown as ChoiceRowProps);
}

describe('FocusAreasRoute stored unknown areas', () => {
  it('shows only the enum rows when no unknown areas are stored', async () => {
    state.config = { focusAreas: ['security', 'bugs'] };
    const { renderer, unmount } = await renderWithProviders(createElement(FocusAreasRoute));
    await waitFor(() => choiceRows(renderer).length === 6);
    expect(choiceRows(renderer).map(row => row.label)).toEqual([
      'Security',
      'Performance',
      'Bugs',
      'Style',
      'Testing',
      'Documentation',
    ]);
    unmount();
  });

  it('appends a selected fallback row per stored unknown area', async () => {
    state.config = { focusAreas: ['security', 'correctness'] };
    const { renderer, unmount } = await renderWithProviders(createElement(FocusAreasRoute));
    await waitFor(() => choiceRows(renderer).length === 7);
    const rows = choiceRows(renderer);
    expect(rows.at(-1)).toMatchObject({ label: 'Other (correctness)', selected: true });
    unmount();
  });

  it('toggling an unknown row saves the selection without it', async () => {
    state.config = { focusAreas: ['correctness'] };
    state.cache = { focusAreas: ['correctness'] };
    const { renderer, unmount } = await renderWithProviders(createElement(FocusAreasRoute));
    await waitFor(() => choiceRows(renderer).length === 7);
    choiceRows(renderer).at(-1)?.onPress?.();
    expect(state.mutate).toHaveBeenCalledWith({ focusAreas: [] });
    unmount();
  });
});
