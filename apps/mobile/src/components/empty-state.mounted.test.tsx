// The centered empty state yields its decorative icon when the band it is being
// centered in cannot hold the full form, and keeps it when the band is tall.
// The scroller that owns the band publishes whether it is short (a phone held
// sideways) and the state only reads the answer; a caller that measured its own
// clear region passes `compact` and owns the presentation decision instead (the
// Agents screen does). Device defect e4/e8: on the Agents no-match state the
// full stack (icon bubble + copy + action) overflowed the band above the fixed
// bottom tab bar, so the copy and the Clear-search action sat under the bar —
// whose overlay owns the taps there — and only a scroll brought them back. The
// compact form drops the decorative bubble and halves the gaps; the title, the
// description and the action all stay.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';

import { EmptyState } from './empty-state';

type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;

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

const ICON_BUBBLE_CLASS = 'h-14 w-14';

function presentationEmptyState(compact: boolean) {
  return (
    <EmptyState
      icon={SearchX}
      title="No sessions match"
      description="Try a different search term."
      compact={compact}
      action={createElement('Action')}
    />
  );
}

function presentationTexts(mounted: Mounted) {
  return mounted.renderer.root
    .findAllByType('Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    );
}

function iconBubbles(mounted: Mounted) {
  return mounted.renderer.root
    .findAllByType('View')
    .filter(node => typeof node.props.className === 'string')
    .filter(node => (node.props.className as string).includes(ICON_BUBBLE_CLASS));
}

function assertKeptContent(mounted: Mounted) {
  expect(presentationTexts(mounted)).toContain('No sessions match');
  expect(presentationTexts(mounted)).toContain('Try a different search term.');
  expect(mounted.renderer.root.findAllByType('Action')).toHaveLength(1);
}

describe('EmptyState presentation', () => {
  it('renders the icon bubble in the full presentation', async () => {
    const mounted = await renderWithProviders(presentationEmptyState(false));
    expect(mounted.renderer.root.findAllByType(SearchX)).toHaveLength(1);
    expect(iconBubbles(mounted)).toHaveLength(1);
    assertKeptContent(mounted);
    mounted.unmount();
  });

  it('drops the icon in the compact presentation and keeps the title, hint and action', async () => {
    const mounted = await renderWithProviders(presentationEmptyState(true));
    expect(mounted.renderer.root.findAllByType(SearchX)).toHaveLength(0);
    expect(iconBubbles(mounted)).toHaveLength(0);
    assertKeptContent(mounted);
    mounted.unmount();
  });

  it('keeps the description node a caller owns in the compact presentation', async () => {
    const description: ReactNode = createElement('AccessibleStatus', null, 'offline');
    const mounted = await renderWithProviders(
      <EmptyState icon={SearchX} title="No sessions match" description={description} compact />
    );
    expect(mounted.renderer.root.findAllByType('AccessibleStatus')).toHaveLength(1);
    mounted.unmount();
  });

  it('lets a caller that measured its own clear region override a tall band', async () => {
    const mounted = await renderWithProviders(presentationEmptyState(true));
    expect(band.short).toBe(false);
    expect(mounted.renderer.root.findAllByType(SearchX)).toHaveLength(0);
    assertKeptContent(mounted);
    mounted.unmount();
  });
});
