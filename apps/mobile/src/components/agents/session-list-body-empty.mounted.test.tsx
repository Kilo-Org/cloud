/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as permission-card.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { BodyEmpty } from './session-list-body-empty';

vi.mock('react-native', () => ({
  View: 'View',
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
      clearQueryAction: createElement('ClearQueryCTA'),
      onRetry: vi.fn(() => undefined),
    });

    expect(textContents(renderer.root)).toContain('No past sessions');
    expect(textContents(renderer.root)).toContain('Completed sessions will appear here.');
    // No action: creation is offered by the FAB/tray, so no create CTA renders.
    expect(findHost(renderer.root, 'Button')).toHaveLength(0);
    expect(findHost(renderer.root, 'ClearQueryCTA')).toHaveLength(0);
    // The History icon identifies this state.
    expect(findHost(renderer.root, 'History')).toHaveLength(1);
  });
});
