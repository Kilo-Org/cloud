/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as permission-card.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { BodyEmpty } from './session-list-body-empty';

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({
  Activity: 'Activity',
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
  it('renders the all-active copy with no creation CTA', async () => {
    const renderer = await renderBody({
      kind: 'all-active',
      isSearching: false,
      emptyStateAction: createElement('NewTaskCTA'),
      clearQueryAction: createElement('ClearQueryCTA'),
      onRetry: vi.fn(() => undefined),
    });

    // The honest all-pinned copy replaces the false "No past sessions".
    expect(textContents(renderer.root)).toContain('All sessions are active');
    expect(textContents(renderer.root)).toContain('Completed sessions will appear here.');
    expect(textContents(renderer.root)).not.toContain('No past sessions');
    // No action: creation is already offered by the tray, the FAB, and the
    // header action, so the passed-in creation CTA must not render.
    expect(findHost(renderer.root, 'NewTaskCTA')).toHaveLength(0);
    // The Activity icon identifies this state (vs History for no-past-sessions).
    expect(findHost(renderer.root, 'Activity')).toHaveLength(1);
  });

  it('keeps the creation CTA on the no-past-sessions body', async () => {
    const renderer = await renderBody({
      kind: 'no-past-sessions',
      isSearching: false,
      emptyStateAction: createElement('NewTaskCTA'),
      clearQueryAction: createElement('ClearQueryCTA'),
      onRetry: vi.fn(() => undefined),
    });

    expect(textContents(renderer.root)).toContain('No past sessions');
    expect(findHost(renderer.root, 'NewTaskCTA')).toHaveLength(1);
  });
});
