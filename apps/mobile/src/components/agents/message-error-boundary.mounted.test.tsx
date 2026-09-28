import { createElement, createRef, type ReactNode, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { act, TestRenderer } from '@/test/renderer';

import { MessageErrorBoundary } from './message-error-boundary';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type BoundaryRenderer = TestRenderer.ReactTestRenderer;
type BoundaryRef = RefObject<MessageErrorBoundary | null>;

const FAILED_TO_RENDER_COPY = 'Failed to render content';

let events: TelemetryEvent[] = [];
const mounted: BoundaryRenderer[] = [];

beforeEach(() => {
  events = [];
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
  setTelemetrySink(null);
});

function ThrowingChild(): never {
  throw new Error('render part failed');
}

function BenignChild(): ReactNode {
  return null;
}

async function mountBoundary(
  child: ReactNode,
  boundaryRef?: BoundaryRef
): Promise<BoundaryRenderer> {
  const holder: { current: BoundaryRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(
      <MessageErrorBoundary ref={boundaryRef}>{child}</MessageErrorBoundary>
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mounted.push(renderer);
  return renderer;
}

/** Mount the boundary (no throwing child) and return its class instance. */
async function mountBoundaryInstance(): Promise<MessageErrorBoundary> {
  const boundaryRef = createRef<MessageErrorBoundary>();
  await mountBoundary(createElement(BenignChild), boundaryRef);
  const boundary = boundaryRef.current;
  if (!boundary) {
    throw new Error('boundary instance missing');
  }
  return boundary;
}

function firstEvent(): TelemetryEvent {
  const event = events[0];
  if (!event) {
    throw new Error('expected a telemetry event');
  }
  return event;
}

function componentStackOf(event: TelemetryEvent): string {
  const value = event.extra?.componentStack;
  if (typeof value !== 'string') {
    throw new TypeError('componentStack extra missing');
  }
  return value;
}

function errorOf(event: TelemetryEvent): Error {
  const { error } = event;
  if (!(error instanceof Error)) {
    throw new TypeError('event error is not an Error');
  }
  return error;
}

function textsOf(renderer: BoundaryRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => String(node.props.children));
}

describe('MessageErrorBoundary — telemetry reporting', () => {
  it('reports one event with subsystem/operation tags and a component stack when a part render throws', async () => {
    const renderer = await mountBoundary(createElement(ThrowingChild));

    expect(events).toHaveLength(1);
    const event = firstEvent();
    expect(event.level).toBe('error');
    expect(errorOf(event).message).toBe('render part failed');
    expect(event.tags).toEqual({
      'error.subsystem': 'agent-message-render',
      'error.operation': 'render_part',
    });
    expect(componentStackOf(event).trim().length).toBeGreaterThan(0);
    expect(event.fingerprint).toContain('Error');
    expect(event.fingerprint).toContain('render part failed');

    // The fallback tile is unchanged and replaces the failing child.
    expect(textsOf(renderer)).toContain(FAILED_TO_RENDER_COPY);
  });

  it('truncates a pathological component stack instead of throwing or bloating the event', async () => {
    const boundary = await mountBoundaryInstance();

    const longStack = '/LongComponent\n'.repeat(50_000);
    expect(() => {
      boundary.componentDidCatch(new Error('render part failed'), { componentStack: longStack });
    }).not.toThrow();

    expect(events).toHaveLength(1);
    const reported = componentStackOf(firstEvent());
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(longStack.length);
    expect(reported.endsWith('…')).toBe(true);
  });

  it('still reports without an extra field when the component stack is absent', async () => {
    const boundary = await mountBoundaryInstance();

    expect(() => {
      boundary.componentDidCatch(new Error('render part failed'), { componentStack: null });
    }).not.toThrow();
    boundary.componentDidCatch(new Error('render part failed'), {});

    expect(events).toHaveLength(2);
    expect(events[0]?.extra).toBeUndefined();
    expect(events[1]?.extra).toBeUndefined();
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'agent-message-render',
      'error.operation': 'render_part',
    });
    expect(events[1]?.fingerprint).toEqual(events[0]?.fingerprint);
  });

  it('reports a non-Error throw instead of dropping it', async () => {
    const boundary = await mountBoundaryInstance();

    expect(() => {
      boundary.componentDidCatch('render part failed', { componentStack: 'a' });
      boundary.componentDidCatch(null, {});
    }).not.toThrow();

    // Both throws report; a non-Error throw gets a stable grouping signature
    // instead of a dropped event or `undefined` fingerprint parts.
    expect(events).toHaveLength(2);
    expect(events[0]?.error).toBe('render part failed');
    expect(events[1]?.error).toBeNull();
    expect(events[0]?.fingerprint).toEqual([
      'agent-message-render',
      'render_part',
      'unknown',
      'unknown',
    ]);
    expect(events[1]?.fingerprint).toEqual(events[0]?.fingerprint);
  });

  it('groups repeated crashes of the same renderer under one fingerprint', async () => {
    const boundary = await mountBoundaryInstance();

    boundary.componentDidCatch(new Error('first boom'), { componentStack: 'a' });
    boundary.componentDidCatch(new Error('first boom'), { componentStack: 'b' });
    boundary.componentDidCatch(new Error('second boom'), { componentStack: 'c' });

    expect(events).toHaveLength(3);
    expect(events[0]?.fingerprint).toEqual(events[1]?.fingerprint);
    expect(events[0]?.fingerprint).not.toEqual(events[2]?.fingerprint);
  });
});
