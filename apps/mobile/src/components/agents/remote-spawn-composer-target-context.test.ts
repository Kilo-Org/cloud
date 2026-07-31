import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

// ── React hooks ────────────────────────────────────────────────────
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useEffect: vi.fn((fn: React.EffectCallback) => {
      fn();
    }),
    useRef: vi.fn(<T>(initial: T) => {
      const ref: React.RefObject<T> = { current: initial };
      return ref;
    }),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
  };
});

// ── react-native ───────────────────────────────────────────────────
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  View: 'View',
}));

// ── sub-components ─────────────────────────────────────────────────
vi.mock('@/components/agents/instance-selector', () => ({
  InstanceSelector: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: 'Button',
}));

vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));

// ── hooks ──────────────────────────────────────────────────────────
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#000',
    mutedForeground: '#666',
    primaryForeground: '#fff',
  }),
}));

// ── helpers ────────────────────────────────────────────────────────
type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function findTextContent(node: Node, predicate: (text: string) => boolean): boolean {
  if (typeof node === 'string') {
    return predicate(node);
  }
  if (node === null || typeof node !== 'object') {
    return false;
  }
  const props = node.props ?? {};
  if (typeof props.children === 'string' && predicate(props.children)) {
    return true;
  }
  const children = props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (findTextContent(child as Node, predicate)) {
      return true;
    }
  }
  return false;
}

const INSTANCE: InstancePickerInstance = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
};

describe('RemoteSpawnComposer hidden selector', () => {
  it('displays a muted target-context line when showRunOnSelector is false and an instance is set', async () => {
    const { RemoteSpawnComposer } = await import('./remote-spawn-composer');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = RemoteSpawnComposer({
      runOnInstance: INSTANCE,
      instanceList: [INSTANCE],
      isLoadingInstances: false,
      onChangeRunOnInstance: vi.fn<(next: InstancePickerInstance | null) => void>(),
      isSpawningRemote: false,
      isStartDisabled: false,
      onStart: vi.fn<() => void>(),
      showRunOnSelector: false,
    }) as Node;

    // The component renders: "Run on: {name} · {projectName}" where
    // targetLabel = "laptop · kilo" is a single text node.
    expect(findTextContent(element, t => t === 'Run on: ')).toBe(true);
    expect(findTextContent(element, t => t.includes(INSTANCE.name))).toBe(true);
    expect(findTextContent(element, t => t.includes(INSTANCE.projectName))).toBe(true);
  });

  it('shows the full InstanceSelector when showRunOnSelector is true', async () => {
    const { RemoteSpawnComposer } = await import('./remote-spawn-composer');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = RemoteSpawnComposer({
      runOnInstance: INSTANCE,
      instanceList: [INSTANCE],
      isLoadingInstances: false,
      onChangeRunOnInstance: vi.fn<(next: InstancePickerInstance | null) => void>(),
      isSpawningRemote: false,
      isStartDisabled: false,
      onStart: vi.fn<() => void>(),
      showRunOnSelector: true,
    }) as Node;

    // "Run on" label is present in selector mode
    expect(findTextContent(element, t => t === 'Run on')).toBe(true);
    // No muted "Run on:" context line in selector mode
    expect(findTextContent(element, t => t === 'Run on:')).toBe(false);
  });

  it('renders nothing for the run target when showRunOnSelector is false and no instance is selected', async () => {
    const { RemoteSpawnComposer } = await import('./remote-spawn-composer');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = RemoteSpawnComposer({
      runOnInstance: null,
      instanceList: [INSTANCE],
      isLoadingInstances: false,
      onChangeRunOnInstance: vi.fn<(next: InstancePickerInstance | null) => void>(),
      isSpawningRemote: false,
      isStartDisabled: false,
      onStart: vi.fn<() => void>(),
      showRunOnSelector: false,
    }) as Node;

    // Neither selector label nor context line is rendered
    expect(findTextContent(element, t => t === 'Run on')).toBe(false);
    expect(findTextContent(element, t => t === 'Run on:')).toBe(false);
  });
});
