import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it, vi } from 'vitest';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { buildAndroidWidgetProps } from './widget-props';

// Stub the widget primitives so the layout functions return inspectable trees
// without loading react-native. The real components are exercised by prebuild.
vi.mock('react-native-android-widget', () => ({
  FlexWidget: (props: Record<string, unknown>) => ({ kind: 'FlexWidget', props }),
  TextWidget: (props: Record<string, unknown>) => ({ kind: 'TextWidget', props }),
  requestWidgetUpdate: () => undefined,
}));

const NOW = 1_750_000_000_000;

type MockElement = {
  kind: string;
  props: {
    text?: string;
    clickAction?: string;
    clickActionData?: { uri?: string };
    accessibilityLabel?: string;
    style?: { backgroundColor?: string };
    children?: unknown;
  };
};

const COPY: Record<string, string> = {
  'glanceable.needsInput': 'Needs input',
  'glanceable.reconnecting': 'Reconnecting',
  'glanceable.running': 'Running',
  'glanceable.empty': 'No work in progress',
  'glanceable.expired': 'Status expired',
  'glanceable.stale': 'Updates delayed',
  'glanceable.openAgents': 'Open agents',
};

function translate(key: string): string {
  return COPY[key] ?? key;
}

function snapshotFor(
  sessions: { status: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node !== 'object') {
    return [];
  }
  const element = node as MockElement;
  const output: string[] = [];
  if (typeof element.props.text === 'string') {
    output.push(element.props.text);
  }
  if (element.props.children !== undefined) {
    output.push(...collectText(element.props.children));
  }
  return output;
}

function render(props: ReturnType<typeof buildAndroidWidgetProps>, width: number) {
  return renderActiveAgentsWidget(props, {
    widgetName: 'ActiveAgentsWidget',
    widgetId: 1,
    width,
    height: 100,
    screenInfo: { screenWidthDp: 400, screenHeightDp: 800, density: 2, densityDpi: 320 },
  }) as unknown as { light: MockElement; dark: MockElement };
}

describe('renderActiveAgentsWidget', () => {
  it('returns distinct light and dark layouts through the theme callback', () => {
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'busy' }], 0), {}, translate);
    const rep = render(props, 250);

    expect(rep.light).toBeDefined();
    expect(rep.dark).toBeDefined();
    expect(rep.light).not.toBe(rep.dark);
    expect(rep.light.props.style?.backgroundColor).toBe('#FFFFFF');
    expect(rep.dark.props.style?.backgroundColor).toBe('#0B0F19');
  });

  it('shows only the primary count at a small width', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'question' }, { status: 'busy' }, { status: 'busy' }], 0),
      {},
      translate
    );
    const rep = render(props, 120);
    const text = collectText(rep.light);

    expect(text).toEqual(['1 Needs input']);
  });

  it('shows every non-zero count and the Open agents affordance at a wide width', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor([{ status: 'question' }, { status: 'busy' }], 0),
      {},
      translate
    );
    const rep = render(props, 250);
    const text = collectText(rep.light);

    expect(text).toEqual(['1 Needs input', '1 Running', 'Open agents']);
  });

  it.each([
    { width: 120, visibleText: ['2 Needs input'] },
    {
      width: 250,
      visibleText: [
        '2 Needs input',
        '3 Reconnecting',
        '4 Running',
        'Updates delayed',
        'Open agents',
      ],
    },
  ])(
    'speaks stale numeric counts and keeps the deep link at width $width',
    ({ width, visibleText }) => {
      const props = buildAndroidWidgetProps(
        {
          ...snapshotFor([], 0, 'stale'),
          needsInput: 2,
          reconnecting: 3,
          running: 4,
        },
        {},
        translate
      );
      const rep = render(props, width);

      for (const surface of [rep.light, rep.dark]) {
        expect(surface.props.accessibilityLabel).toBe(
          'Updates delayed, 2 Needs input, 3 Reconnecting, 4 Running, Open agents'
        );
        expect(collectText(surface)).toEqual(visibleText);
        expect(surface.props.clickAction).toBe('OPEN_URI');
        expect(surface.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
      }
    }
  );

  it('hides counts and shows expired copy for an expired snapshot', () => {
    const props = buildAndroidWidgetProps(
      {
        ...snapshotFor([{ status: 'busy' }], 0),
        status: 'expired',
        running: 0,
        needsInput: 0,
        reconnecting: 0,
      },
      {},
      translate
    );
    const rep = render(props, 250);
    const text = collectText(rep.light);

    expect(text).toEqual(['Status expired']);
  });

  it('labels the whole widget with the Open agents deep-link click action', () => {
    const props = buildAndroidWidgetProps(snapshotFor([{ status: 'busy' }], 0), {}, translate);
    const rep = render(props, 250);

    expect(rep.light.props.clickAction).toBe('OPEN_URI');
    expect(rep.light.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
    expect(rep.dark.props.clickAction).toBe('OPEN_URI');
    expect(rep.dark.props.clickActionData).toEqual({ uri: 'kiloapp:///cloud/sessions' });
  });
});
