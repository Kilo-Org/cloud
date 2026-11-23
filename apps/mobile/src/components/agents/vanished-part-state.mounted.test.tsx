// The vanished-part state is the body both transcript sheets show when the item
// they presented is no longer in the session's live messages: the part detail
// sheet whose part id stops resolving, and the tool-run sheet whose run has no
// live parts left. It is the shared state block, centered in the sheet and
// carrying no action — nothing can be re-read, and each sheet's header Done is
// the way out. These cases mount the real `EmptyState` so the shape the sheets
// get is the one asserted, not a stub's.

import { createElement, type ReactNode } from 'react';
import { type TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';
import { EmptyState } from '@/components/empty-state';
import { Info } from '@/components/ui/icons';

import { VanishedPartState } from './vanished-part-state';

vi.mock('react-native', () => ({
  View: 'View',
  // EmptyState reads the scheme for its dark disc and glyph ink.
  useColorScheme: () => 'light',
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children: ReactNode }) =>
    createElement('CenteredState', null, props.children),
}));
vi.mock('@/components/centered-state-band', () => ({
  useShortCenteredBand: () => false,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Info: 'Info' }));
vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: ReactNode }) => createElement('Button', props),
}));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#777777',
    primaryForeground: '#ffffff',
    foreground: '#111111',
    ink2: '#111111',
  }),
  useMutedDisabledInk: () => '#777777',
}));

function propOf(instance: TestRenderer.ReactTestInstance, key: string): unknown {
  /* eslint-disable-next-line typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
}

/** Every drawn string in the tree, in render order. */
function textsOf(mounted: RenderWithProvidersResult): unknown[] {
  return mounted.renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => propOf(node, 'children'));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VanishedPartState', () => {
  it('renders the shared centered state with the details-unavailable copy', async () => {
    const mounted = await renderWithProviders(createElement(VanishedPartState));
    const state = mounted.renderer.root.findByType(EmptyState);

    // The state is the whole sheet body, so it centers itself and owns the
    // page gutter through the state block's own inset.
    expect(propOf(state, 'placement')).toBe('center');
    expect(propOf(state, 'icon')).toBe(Info);
    expect(propOf(state, 'title')).toBe(i18n.t('agentChat.partDetail.detailsUnavailable'));
    expect(propOf(state, 'description')).toBe(
      i18n.t('agentChat.partDetail.detailsUnavailableDescription')
    );

    // Nothing can be re-read or retried: the part is absent from the live
    // messages, so the state carries no action and the header Done closes it.
    expect(propOf(state, 'action')).toBeUndefined();

    // `placement="center"` is what puts the state in the shared CenteredState.
    expect(
      mounted.renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'CenteredState'
      )
    ).toHaveLength(1);

    expect(textsOf(mounted)).toEqual([
      i18n.t('agentChat.partDetail.detailsUnavailable'),
      i18n.t('agentChat.partDetail.detailsUnavailableDescription'),
    ]);

    mounted.unmount();
  });
});
