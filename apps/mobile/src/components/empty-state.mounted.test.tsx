import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';

import { EmptyState } from './empty-state';

// The mounted harness runs DOM-free, so `react-native` and the text primitive
// are reduced to host nodes exactly as `centered-state.mounted.test.tsx` does;
// `CenteredState` is stubbed because its measurement is covered there.
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ SearchX: () => null }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;

const ICON_BUBBLE_CLASS = 'h-14 w-14';

function emptyState(compact: boolean) {
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

function texts(mounted: Mounted) {
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
  expect(texts(mounted)).toContain('No sessions match');
  expect(texts(mounted)).toContain('Try a different search term.');
  expect(mounted.renderer.root.findAllByType('Action')).toHaveLength(1);
}

describe('EmptyState presentation', () => {
  it('renders the icon bubble in the full presentation', async () => {
    const mounted = await renderWithProviders(emptyState(false));
    expect(mounted.renderer.root.findAllByType(SearchX)).toHaveLength(1);
    expect(iconBubbles(mounted)).toHaveLength(1);
    assertKeptContent(mounted);
    mounted.unmount();
  });

  it('drops the icon in the compact presentation and keeps the title, hint and action', async () => {
    const mounted = await renderWithProviders(emptyState(true));
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
});
