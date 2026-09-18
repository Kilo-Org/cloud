/* eslint-disable max-lines -- one cohesive font-contract suite sharing the mock-element tree harness */
import { type WidgetFamily } from 'expo-widgets';
import { describe, expect, it, vi } from 'vitest';

import { activeAgentsWidgetLayout } from './active-agents-widget';
import { type GlanceableWidgetProps } from './view-props';

// The swift-ui primitives and modifiers are recording stubs: the layout is the
// real logic under test, and the modifier list it hands the widget process is
// exactly what these tests read back.
function mockComponent(kind: string) {
  const fn = (props: Record<string, unknown>) => ({ kind, props });
  (fn as unknown as { kind: string }).kind = kind;
  return fn;
}

function mockModifier(name: string) {
  return (args?: unknown) => ({ $type: name, args });
}

vi.mock('expo-widgets', () => ({
  widgetsDirectory: 'file:///app-group/ExpoWidgets/',
  createWidget: () => ({
    updateSnapshot: () => undefined,
    updateTimeline: () => undefined,
    reload: () => undefined,
  }),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Image: () => null,
}));

vi.mock('@expo/ui/swift-ui', () => ({
  Button: mockComponent('Button'),
  HStack: mockComponent('HStack'),
  Image: mockComponent('Image'),
  Spacer: mockComponent('Spacer'),
  Text: mockComponent('Text'),
  VStack: mockComponent('VStack'),
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityElement: mockModifier('accessibilityElement'),
  accessibilityLabel: mockModifier('accessibilityLabel'),
  allowsTightening: mockModifier('allowsTightening'),
  buttonStyle: mockModifier('buttonStyle'),
  containerBackground: mockModifier('containerBackground'),
  controlSize: mockModifier('controlSize'),
  cornerRadius: mockModifier('cornerRadius'),
  environment: mockModifier('environment'),
  font: mockModifier('font'),
  foregroundStyle: mockModifier('foregroundStyle'),
  frame: mockModifier('frame'),
  layoutPriority: mockModifier('layoutPriority'),
  lineLimit: mockModifier('lineLimit'),
  minimumScaleFactor: mockModifier('minimumScaleFactor'),
  monospacedDigit: mockModifier('monospacedDigit'),
  resizable: mockModifier('resizable'),
  widgetURL: mockModifier('widgetURL'),
}));

vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));

const HAPPY_WAITING_PROPS: GlanceableWidgetProps = {
  statusLine: null,
  countLines: [
    { label: 'Needs input', kind: 'needsInput', count: 1 },
    { label: 'Working', kind: 'running', count: 1 },
    { label: 'Idle', kind: 'idle', count: 0 },
  ],
  primaryLabel: 'Needs input',
  primaryKind: 'needsInput',
  primaryCount: 1,
  newestTitle: 'Newest: Fix the flaky test',
  actions: { approve: true, newAgent: false },
  needsInputSince: null,
  accessibilityLabel: 'spoken label',
};

const EMPTY_WIDGET_PROPS: GlanceableWidgetProps = {
  statusLine: 'No agents waiting',
  countLines: [],
  primaryLabel: null,
  primaryKind: null,
  primaryCount: 0,
  newestTitle: null,
  actions: { approve: false, newAgent: true },
  needsInputSince: null,
  accessibilityLabel: 'spoken label',
};

type MockElement = { kind: string; props: Record<string, unknown> };
type FontArgs = { textStyle?: string; weight?: string };

function renderWidget(props: GlanceableWidgetProps, family: WidgetFamily): MockElement {
  return activeAgentsWidgetLayout(props, {
    widgetFamily: family,
    date: new Date(0),
    configuration: undefined,
  }) as unknown as MockElement;
}

function collect(node: unknown): MockElement[] {
  if (node == null || typeof node !== 'object') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collect(item));
  }
  const kind = (node as { type?: { kind?: string } }).type?.kind;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (kind === undefined || props === undefined) {
    return [];
  }
  return [{ kind, props }, ...collect(props.children)];
}

/** The recorded `font` modifier's arguments, or undefined when the Text has none. */
function fontArgs(element: MockElement | undefined): FontArgs | undefined {
  const modifiers = element?.props.modifiers;
  if (!Array.isArray(modifiers)) {
    return undefined;
  }
  const found = (modifiers as { $type?: string; args?: FontArgs }[]).find(
    modifier => modifier.$type === 'font'
  );
  return found?.args;
}

function fontArgsForText(tree: unknown, text: string): FontArgs | undefined {
  return fontArgs(
    collect(tree).find(element => element.kind === 'Text' && element.props.children === text)
  );
}

describe('activeAgentsWidgetLayout font weights', () => {
  // The app's own body text is `font-medium` (the `Text` default in
  // components/ui/text). A regular widget label read lighter than every string
  // the app draws, so every non-emphasised line carries the app's body weight;
  // the count keeps its semibold emphasis.
  it('draws the count labels and the newest line at the app body weight', () => {
    const tree = renderWidget(HAPPY_WAITING_PROPS, 'systemSmall');

    expect(fontArgsForText(tree, 'Needs input')).toEqual({
      textStyle: 'subheadline',
      weight: 'medium',
    });
    expect(fontArgsForText(tree, 'Newest: Fix the flaky test')).toEqual({
      textStyle: 'caption',
      weight: 'medium',
    });
    // The number is the row's emphasis, so it keeps its semibold weight.
    expect(fontArgsForText(tree, '1')).toEqual({ textStyle: 'subheadline', weight: 'semibold' });
  });

  it('draws the status copy at the app body weight in every family that carries it', () => {
    for (const family of ['systemSmall', 'systemMedium'] as WidgetFamily[]) {
      expect(
        fontArgsForText(renderWidget(EMPTY_WIDGET_PROPS, family), 'No agents waiting')
      ).toEqual({ textStyle: 'footnote', weight: 'medium' });
    }
    expect(
      fontArgsForText(renderWidget(EMPTY_WIDGET_PROPS, 'accessoryRectangular'), 'No agents waiting')
    ).toEqual({ textStyle: 'subheadline', weight: 'medium' });
  });

  it('draws the relative wait at the app body weight', () => {
    const tree = renderWidget(
      { ...HAPPY_WAITING_PROPS, needsInputSince: new Date(1_750_000_000_000).toISOString() },
      'systemMedium'
    );
    const wait = collect(tree).find(element => element.props.dateStyle === 'relative');

    expect(fontArgs(wait)).toEqual({ textStyle: 'subheadline', weight: 'medium' });
  });
});
