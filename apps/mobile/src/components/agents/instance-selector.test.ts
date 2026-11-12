import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';

import '@/i18n';

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

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('react-native', () => ({
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
}));

vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));

type Node = { props?: Record<string, unknown> } | null | undefined | string | number | boolean;

function textValues(node: Node): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).flatMap(child =>
    textValues(child as Node)
  );
}

/** The props of the closed selector's value line, the only `flex-1` text. */
function valueProps(node: Node): Record<string, unknown> | undefined {
  if (node === null || typeof node !== 'object') {
    return undefined;
  }
  const props = node.props;
  if (typeof props?.className === 'string' && props.className.includes('flex-1')) {
    return props;
  }
  const children = props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = valueProps(child as Node);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function valueClassName(node: Node): string | undefined {
  const className = valueProps(node)?.className;
  return typeof className === 'string' ? className : undefined;
}

const INSTANCE = {
  connectionId: 'conn-abc',
  name: 'laptop',
  projectName: 'kilo',
  kind: 'cli' as const,
  startedAt: null,
  gitBranch: null,
};

function baseProps() {
  return {
    value: null as typeof INSTANCE | null,
    instances: [INSTANCE],
    isLoading: false,
    onChange: vi.fn(),
  };
}

describe('InstanceSelector closed label', () => {
  it.each([
    ['cloud default', baseProps(), 'Cloud Agent'],
    ['loading', { ...baseProps(), isLoading: true }, 'Loading…'],
  ])('labels the %s', async (_name, props, expected) => {
    const { InstanceSelector } = await import('./instance-selector');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(props) as Node;

    expect(textValues(element)).toContain(expected);
  });

  it('labels the unbound computer target instead of the Cloud Agent default', async () => {
    const { InstanceSelector } = await import('./instance-selector');
    const props = { ...baseProps(), pendingComputer: true };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(props) as Node;

    expect(textValues(element)).toContain('No CLI instances connected');
    expect(textValues(element)).not.toContain('Cloud Agent');
  });

  it('labels the bound computer over any pending state', async () => {
    const { InstanceSelector } = await import('./instance-selector');
    const props = { ...baseProps(), value: INSTANCE, pendingComputer: true };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(props) as Node;

    expect(textValues(element)).toContain('laptop · kilo');
    expect(textValues(element)).not.toContain('No CLI instances connected');
  });
});

describe('InstanceSelector closed label ink', () => {
  it('gives the selected Cloud Agent default value ink, not placeholder ink', async () => {
    const { InstanceSelector } = await import('./instance-selector');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(baseProps()) as Node;

    const className = valueClassName(element) ?? '';
    expect(className).toContain('text-foreground');
    expect(className).not.toContain('text-muted-foreground');
  });

  it.each([
    ['the loading copy', { ...baseProps(), isLoading: true }],
    ['the unbound computer', { ...baseProps(), pendingComputer: true }],
  ])('keeps placeholder ink while it shows %s', async (_name, props) => {
    const { InstanceSelector } = await import('./instance-selector');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(props) as Node;

    expect(valueClassName(element) ?? '').toContain('text-muted-foreground');
  });
});

describe('InstanceSelector closed label truncation', () => {
  it('truncates a selected target in the middle so its project stays visible', async () => {
    const { InstanceSelector } = await import('./instance-selector');
    const props = { ...baseProps(), value: INSTANCE };

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(props) as Node;

    expect(valueProps(element)?.ellipsizeMode).toBe('middle');
  });

  it.each([
    ['the Cloud Agent default', baseProps],
    ['the loading copy', () => ({ ...baseProps(), isLoading: true })],
    ['the unbound computer', () => ({ ...baseProps(), pendingComputer: true })],
  ])('keeps a tail cut for %s', async (_name, buildProps) => {
    const { InstanceSelector } = await import('./instance-selector');

    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = InstanceSelector(buildProps()) as Node;

    expect(valueProps(element)?.ellipsizeMode).toBe('tail');
  });
});
