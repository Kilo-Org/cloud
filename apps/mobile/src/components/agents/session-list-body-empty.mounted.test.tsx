import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { BodyEmpty } from './session-list-body-empty';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  History: 'History',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#999999' }),
}));

type BodyEmptyProps = Parameters<typeof BodyEmpty>[0];

async function renderBody(props: BodyEmptyProps): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(BodyEmpty, props));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

function textContents(root: TestRenderer.ReactTestInstance): unknown[] {
  return findHost(root, 'Text').map(node => node.props.children);
}

describe('BodyEmpty mounted', () => {
  it('renders the no-past-sessions copy with no creation CTA', async () => {
    const renderer = await renderBody({
      kind: 'no-past-sessions',
      isSearching: false,
      hasActiveFilters: false,
      clearActions: createElement('ClearActions'),
      onRetry: vi.fn(() => undefined),
    });

    expect(textContents(renderer.root)).toContain('No past sessions');
    expect(textContents(renderer.root)).toContain('Completed sessions will appear here.');
    // No action: creation is offered by the FAB/tray, so no create CTA renders.
    expect(findHost(renderer.root, 'Button')).toHaveLength(0);
    expect(findHost(renderer.root, 'ClearActions')).toHaveLength(0);
    // The History icon identifies this state.
    expect(findHost(renderer.root, 'History')).toHaveLength(1);
  });

  it.each([
    {
      name: 'a search alone',
      isSearching: true,
      hasActiveFilters: false,
      description: 'Try a different search term.',
    },
    {
      name: 'a filter alone',
      isSearching: false,
      hasActiveFilters: true,
      description: 'Try adjusting or clearing your filters.',
    },
    {
      name: 'a search and a filter together',
      isSearching: true,
      hasActiveFilters: true,
      description: 'Try a different search term. Try adjusting or clearing your filters.',
    },
  ])('names every cause in the filtered-empty copy for $name', async test => {
    const renderer = await renderBody({
      kind: 'filtered-empty',
      isSearching: test.isSearching,
      hasActiveFilters: test.hasActiveFilters,
      clearActions: createElement('ClearActions'),
      onRetry: vi.fn(() => undefined),
    });

    expect(textContents(renderer.root)).toContain('No sessions match');
    expect(textContents(renderer.root)).toContain(test.description);
    // The state's action row is rendered as given, so each cause keeps its own
    // control.
    expect(findHost(renderer.root, 'ClearActions')).toHaveLength(1);
    expect(findHost(renderer.root, 'SearchX')).toHaveLength(1);
  });

  it('keeps the clear actions beside the retry in the query-error body', async () => {
    const renderer = await renderBody({
      kind: 'query-error-empty',
      isSearching: true,
      hasActiveFilters: true,
      clearActions: createElement('ClearActions'),
      onRetry: vi.fn(() => undefined),
    });

    expect(findHost(renderer.root, 'QueryError')).toHaveLength(1);
    expect(findHost(renderer.root, 'ClearActions')).toHaveLength(1);
  });

  it('renders no clear control when the failed body had no active query', async () => {
    const renderer = await renderBody({
      kind: 'query-error-empty',
      isSearching: false,
      hasActiveFilters: false,
      onRetry: vi.fn(() => undefined),
    });

    expect(findHost(renderer.root, 'QueryError')).toHaveLength(1);
    expect(findHost(renderer.root, 'ClearActions')).toHaveLength(0);
  });
});
