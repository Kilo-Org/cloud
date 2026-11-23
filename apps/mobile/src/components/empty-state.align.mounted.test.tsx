// A state inside a section (the trigger screen's Deliveries block) lines up
// with the section label and the start-aligned rows it belongs to, and its copy
// reads from that edge. The default stays centred for the state that is the
// whole surface. The presentation suite is at its line limit, so this contract
// keeps its own file.

import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';

import { EmptyState } from './empty-state';

type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;

vi.mock('react-native', () => ({
  View: 'View',
  useColorScheme: () => 'light',
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/components/centered-state', () => ({
  CenteredState: (props: { children: ReactNode }) =>
    createElement('CenteredState', null, props.children),
}));
vi.mock('@/components/centered-state-band', () => ({ useShortCenteredBand: () => false }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: 'SearchX' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#777777',
    primaryForeground: '#ffffff',
    foreground: '#111111',
  }),
  useMutedDisabledInk: () => '#777777',
}));

const TITLE = 'No sessions match';

const alignmentState = (align?: 'start', placement?: 'top') =>
  renderWithProviders(
    <EmptyState
      align={align}
      placement={placement}
      icon={SearchX}
      title={TITLE}
      description="Try a different search term."
      action={createElement('Action')}
    />
  );

/** The body's root: the view that carries the placement's own air. */
const body = (mounted: Mounted) =>
  mounted.renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'View')
    .at(0);

/** The body's own stack: the view that carries the form's gap. */
const stack = (mounted: Mounted) =>
  mounted.renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'View')
    .find(node => String(node.props.className).includes('gap-4'));

const title = (mounted: Mounted) =>
  mounted.renderer.root.findAllByType('Text').find(node => node.props.children === TITLE);

const texts = (mounted: Mounted) =>
  mounted.renderer.root
    .findAllByType('Text')
    .map(node =>
      node.children.filter((child): child is string => typeof child === 'string').join('')
    );

let mounted: Mounted | undefined = undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

describe('EmptyState horizontal alignment', () => {
  it('puts the stack and the copy on the start edge when asked', async () => {
    mounted = await alignmentState('start');

    expect(String(stack(mounted)?.props.className)).toContain('items-start');
    // No alignment class: this build drops `text-start`, so the paragraph takes
    // the interface's start edge by default.
    expect(title(mounted)?.props.className).not.toContain('text-center');
    // The copy and the one action stay exactly as the default form draws them.
    expect(texts(mounted)).toContain(TITLE);
    expect(texts(mounted)).toContain('Try a different search term.');
    expect(mounted.renderer.root.findAllByType('Action')).toHaveLength(1);
  });

  it('keeps the centred form when no alignment is given', async () => {
    mounted = await alignmentState();

    expect(String(stack(mounted)?.props.className)).toContain('items-center');
    expect(title(mounted)?.props.className).toContain('text-center');
    expect(texts(mounted)).toContain(TITLE);
  });

  // The top pin is the air a `top` state takes from the surface above it. A
  // state inside a section already has that spacing from the section gap, so
  // the start form takes none and the call site passes no cancelling class.
  it('takes no top pin in the start form', async () => {
    const start = await alignmentState('start', 'top');
    expect(String(body(start)?.props.className)).not.toContain('pt-16');
    start.unmount();
    mounted = undefined;

    mounted = await alignmentState(undefined, 'top');
    expect(String(body(mounted)?.props.className)).toContain('pt-16');
  });
});
