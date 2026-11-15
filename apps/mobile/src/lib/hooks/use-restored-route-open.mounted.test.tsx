import { createElement } from 'react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { _resetLastRouteForTests, noteRestoredRouteOpen } from '@/lib/last-route';
import { useRestoredRouteOpen } from './use-restored-route-open';

const mounted: { renderer: ReactTestRenderer | undefined } = { renderer: undefined };

function Probe({
  destination,
  focusedRoute,
}: Readonly<{ destination: string; focusedRoute: string }>) {
  // The screen renders its own destination while another route can hold focus,
  // so the probe re-renders with that route without changing its destination.
  const isRestored = useRestoredRouteOpen(destination);
  return createElement('Text', null, `${focusedRoute}:${String(isRestored)}`);
}

function mount(destination: string, focusedRoute = destination): void {
  act(() => {
    mounted.renderer = TestRenderer.create(createElement(Probe, { destination, focusedRoute }));
  });
}

function update(destination: string, focusedRoute = destination): void {
  act(() => {
    mounted.renderer?.update(createElement(Probe, { destination, focusedRoute }));
  });
}

function answer(): string | undefined {
  const text = mounted.renderer?.root.findAllByType('Text')[0];
  return text?.children[0] as string | undefined;
}

beforeEach(() => {
  _resetLastRouteForTests();
  mounted.renderer = undefined;
  onTestFinished(() => {
    act(() => {
      mounted.renderer?.unmount();
    });
  });
});

describe('useRestoredRouteOpen', () => {
  it('reports the restored destination and keeps the answer across re-renders', () => {
    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored?at=msg_1');
    mount('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');

    update('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');
  });

  it('keeps the answer while another route holds focus above the screen', () => {
    // A sheet or a share gate re-renders the screen under it; the destination
    // it renders is unchanged, so its answer must not be asked again and lost.
    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    mount('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');

    update('/agent-chat/ses_restored', '/share/gate');
    expect(answer()).toBe('/share/gate:true');

    update('/agent-chat/ses_restored', '/agent-chat/model-picker');
    expect(answer()).toBe('/agent-chat/model-picker:true');

    update('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');
  });

  it('asks again when the navigator reuses the instance for another session', () => {
    // The restored open is replaced by a session the person picked: the same
    // route instance now serves a different destination, so the previous
    // session's answer must not carry over.
    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    mount('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');

    update('/agent-chat/ses_picked');
    expect(answer()).toBe('/agent-chat/ses_picked:false');
  });

  it('answers the destination the repair navigated to, after an earlier mount took nothing', () => {
    // A screen can mount before the repair runs — the cold start's own restored
    // route — and asks while no mark exists. The repair then marks and
    // navigates; the same instance must read the mark for the new destination.
    mount('/agent-chat/ses_launch');
    expect(answer()).toBe('/agent-chat/ses_launch:false');

    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    update('/agent-chat/ses_restored');
    expect(answer()).toBe('/agent-chat/ses_restored:true');
  });

  it('reports false when no restore ran', () => {
    mount('/agent-chat/ses_picked');
    expect(answer()).toBe('/agent-chat/ses_picked:false');
  });
});
