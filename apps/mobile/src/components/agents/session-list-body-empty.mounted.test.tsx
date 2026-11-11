import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { BodyEmpty } from './session-list-body-empty';

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
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
vi.mock('@/components/ui/accessible-status', () => ({
  AccessibleStatus: 'AccessibleStatus',
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

  it('names each body state for placement memory', async () => {
    // These bodies swap in place on one screen: clearing a no-match search hands
    // over to the no-past-sessions body. A shared identity would make the state
    // that mounts second paint its first frame at the previous one's size.
    const kinds = ['no-past-sessions', 'filtered-empty', 'query-error-empty'] as const;
    const keys = await Promise.all(
      kinds.map(async kind => {
        const renderer = await renderBody({
          kind,
          stateKey: 'session-history',
          isSearching: true,
          clearQueryAction: createElement('ClearQueryCTA'),
          onRetry: vi.fn(() => undefined),
        });
        const state = findHost(renderer.root, 'CenteredState')[0];
        const stateKey = state === undefined ? null : state.props.stateKey;
        renderer.unmount();
        return [kind, stateKey] as const;
      })
    );

    expect(Object.fromEntries(keys)).toEqual({
      'no-past-sessions': 'session-history:no-past-sessions',
      'filtered-empty': 'session-history:filtered-empty',
      'query-error-empty': 'session-history:query-error-empty',
    });
  });
});
