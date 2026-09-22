import { describe, expect, it, vi } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

vi.mock('react-native', () => ({ View: 'View' }));

vi.mock('@/components/agents/instance-selector', () => ({
  InstanceSelector: 'InstanceSelector',
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ RefreshCw: 'RefreshCw' }));
vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000' }),
}));

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

function findElementByType(node: Node, typeName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  const props = node.props ?? {};
  const children = props.children;
  const type = (node as { type?: unknown }).type;
  if (type === typeName) {
    return node.props ?? {};
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child as Node, typeName);
    if (found) {
      return found;
    }
  }
  return null;
}

const INSTANCE: InstancePickerInstance = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'cli',
  startedAt: null,
  gitBranch: null,
};

function baseProps() {
  return {
    showRunOnSelector: true,
    runOnInstance: null as InstancePickerInstance | null,
    instanceList: [INSTANCE] as InstancePickerInstance[],
    isLoadingInstances: false,
    isFetchingInstances: false,
    onChangeRunOnInstance: vi.fn(),
    onRefreshInstances: vi.fn(),
    disabled: false,
  };
}

describe('NewSessionRunTarget', () => {
  it('wires the selector value, loading flags and change callback', async () => {
    const { NewSessionRunTarget } = await import('./new-session-run-target');
    const props = { ...baseProps(), runOnInstance: INSTANCE, isLoadingInstances: true };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionRunTarget(props) as Node;

    const selector = findElementByType(element, 'InstanceSelector');
    expect(selector).toMatchObject({
      value: INSTANCE,
      instances: [INSTANCE],
      isLoading: true,
      disabled: false,
      onChange: props.onChangeRunOnInstance,
    });
    expect(findTextContent(element, t => t === 'Run on')).toBe(true);
  });

  it.each([false, true])(
    'renders the refresh control with fetching=%s driving disabled and busy',
    async isFetchingInstances => {
      const { NewSessionRunTarget } = await import('./new-session-run-target');
      const props = { ...baseProps(), isFetchingInstances };

      // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
      const element = NewSessionRunTarget(props) as Node;

      const button = findElementByType(element, 'Button');
      expect(button).toMatchObject({
        accessibilityLabel: 'Refresh',
        size: 'icon',
        disabled: isFetchingInstances,
        loading: isFetchingInstances,
        onPress: props.onRefreshInstances,
      });
      if (!isFetchingInstances) {
        const onPress = button?.onPress as (() => void) | undefined;
        if (!onPress) {
          throw new Error('Missing target refresh handler');
        }
        onPress();
        expect(props.onRefreshInstances).toHaveBeenCalledOnce();
        expect(props.onChangeRunOnInstance).not.toHaveBeenCalled();
      }
    }
  );

  it('disables the selector and the refresh control while the form is busy', async () => {
    const { NewSessionRunTarget } = await import('./new-session-run-target');
    const props = { ...baseProps(), runOnInstance: INSTANCE, disabled: true };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionRunTarget(props) as Node;

    expect(findElementByType(element, 'InstanceSelector')?.disabled).toBe(true);
    expect(findElementByType(element, 'Button')?.disabled).toBe(true);
  });

  it('names the clone target when the selector is hidden', async () => {
    const { NewSessionRunTarget } = await import('./new-session-run-target');
    const props = { ...baseProps(), showRunOnSelector: false, runOnInstance: INSTANCE };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionRunTarget(props) as Node;

    expect(findTextContent(element, t => t === 'Run on: laptop · kilo')).toBe(true);
    expect(findElementByType(element, 'InstanceSelector')).toBeNull();
  });

  it('renders nothing when the selector is hidden and no target is set', async () => {
    const { NewSessionRunTarget } = await import('./new-session-run-target');
    const props = { ...baseProps(), showRunOnSelector: false };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = NewSessionRunTarget(props) as Node;

    expect(element).toBeNull();
  });
});
