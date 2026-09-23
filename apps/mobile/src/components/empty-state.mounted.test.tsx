import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';

import { EmptyState } from './empty-state';

/**
 * A centered empty state is laid out in the band the page leaves between its
 * header and the fixed bottom tab bar, and that band is short in a landscape
 * window. Device defect e4: on the Agents no-match state the full stack (icon
 * bubble + copy + action) overflowed the band, so the copy and the Clear-search
 * action sat under the tab bar — whose overlay owns the taps there — and only a
 * scroll brought them back. The compact form these cases pin drops the
 * decorative bubble and halves the gaps so the copy and the action stay on
 * screen; a tall band keeps the full stack, and a state the caller lays out
 * itself never compacts.
 */

// The scroller owns the band and publishes whether it is short; the state only
// reads the answer.
const band = vi.hoisted(() => ({ short: false }));

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children: ReactNode }) =>
    createElement('CenteredState', null, props.children),
}));
vi.mock('@/components/centered-state-band', () => ({
  useShortCenteredBand: () => band.short,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

const action = createElement('Button', null, 'Clear search');

type Host = { props: { className?: string } };

async function mount() {
  const mounted = await renderWithProviders(
    <EmptyState
      icon={SearchX}
      title="No sessions match"
      description="Try a different search term."
      action={action}
    />
  );
  // The `CenteredState` mock renders its children; the state's own body is the
  // outermost host it renders, and it carries the gap classes.
  const content = mounted.renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'View'
  )[0] as Host | undefined;
  if (!content) {
    throw new Error('the empty state body did not render');
  }
  return { mounted, content };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  band.short = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmptyState in a centered band', () => {
  it('keeps the icon bubble and the full gaps in a tall band', async () => {
    const { mounted, content } = await mount();

    expect(content.props.className).toContain('gap-4');
    expect(content.props.className).not.toContain('gap-2');
    expect(mounted.renderer.root.findAllByType('SearchX')).toHaveLength(1);

    mounted.unmount();
  });

  it('drops the bubble and tightens the gaps in a short band', async () => {
    band.short = true;

    const { mounted, content } = await mount();

    expect(content.props.className).toContain('gap-2');
    expect(content.props.className).not.toContain('gap-4');
    // The state itself is intact: its title, its copy and its action all stay.
    expect(mounted.renderer.root.findAllByType('SearchX')).toHaveLength(0);
    const texts = mounted.renderer.root
      .findAllByType('Text')
      .map(node => node.props.children)
      .join('\n');
    expect(texts).toContain('No sessions match');
    expect(texts).toContain('Try a different search term.');
    expect(mounted.renderer.root.findAllByType('Button')).toHaveLength(1);

    mounted.unmount();
  });

  it('keeps the full stack for a state the caller lays out itself', async () => {
    band.short = true;

    const mounted = await renderWithProviders(
      <EmptyState
        icon={SearchX}
        title="No sessions match"
        description="Try a different search term."
        placement="top"
      />
    );

    expect(mounted.renderer.root.findAllByType('SearchX')).toHaveLength(1);
    expect(mounted.renderer.root.findAllByType('CenteredState')).toHaveLength(0);

    mounted.unmount();
  });
});
