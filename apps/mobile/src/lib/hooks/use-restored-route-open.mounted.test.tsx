import { createElement } from 'react';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { _resetLastRouteForTests, noteRestoredRouteOpen } from '@/lib/last-route';
import { useRestoredRouteOpen } from './use-restored-route-open';

const mounted: { renderer: ReactTestRenderer | undefined } = { renderer: undefined };

function Probe({ pathname }: Readonly<{ pathname: string }>) {
  const isRestored = useRestoredRouteOpen(pathname);
  return createElement('Text', null, String(isRestored));
}

function mount(pathname: string): void {
  act(() => {
    mounted.renderer = TestRenderer.create(createElement(Probe, { pathname }));
  });
}

function update(pathname: string): void {
  act(() => {
    mounted.renderer?.update(createElement(Probe, { pathname }));
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
  it('reports the restored route and keeps the answer across re-renders', () => {
    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    mount('/agent-chat/ses_restored');
    expect(answer()).toBe('true');

    update('/agent-chat/ses_restored');
    expect(answer()).toBe('true');
  });

  it('asks again when the navigator reuses the instance for another session', () => {
    // The restored open is replaced by a session the person picked: the same
    // route instance now serves a different destination, so the previous
    // session's answer must not carry over.
    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    mount('/agent-chat/ses_restored');
    expect(answer()).toBe('true');

    update('/agent-chat/ses_picked');
    expect(answer()).toBe('false');
  });

  it('answers the route the repair navigated to, after an earlier mount took nothing', () => {
    // A screen can mount before the repair runs — the cold start's own restored
    // route — and asks while no mark exists. The repair then marks and
    // navigates; the same instance must read the mark for the new route.
    mount('/agent-chat/ses_launch');
    expect(answer()).toBe('false');

    noteRestoredRouteOpen('/(app)/agent-chat/ses_restored');
    update('/agent-chat/ses_restored');
    expect(answer()).toBe('true');
  });

  it('reports false when no restore ran', () => {
    mount('/agent-chat/ses_picked');
    expect(answer()).toBe('false');
  });
});