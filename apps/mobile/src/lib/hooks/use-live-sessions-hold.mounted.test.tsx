/* eslint-disable max-lines -- DOM-free mounted test: the live rows hold is timer-driven, so the window's start, refresh, and expiry each need a render. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_SESSIONS_EMPTY_HOLD_MS } from '@/lib/live-sessions-render-hold';
import { useLiveSessionsHold } from '@/lib/hooks/use-live-sessions-hold';

type Row = { id: string };
type ProbeInput = { current: Row[]; scopeKey: string; canHold: boolean };

const row = (id: string): Row => ({ id });

function Probe(input: ProbeInput) {
  const rows = useLiveSessionsHold(input);
  return createElement('HeldRows', { ids: rows.map(entry => entry.id).join(',') });
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

async function render(input: ProbeInput): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    const element = createElement(Probe, input);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
}

function heldIds(): string {
  if (!renderer) {
    throw new Error('HeldRows is not mounted');
  }
  return String(renderer.root.findByType('HeldRows').props.ids ?? '');
}

async function advanceBy(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useLiveSessionsHold', () => {
  it('shows the held rows through the window and releases to empty when it expires', async () => {
    const rows = [row('a1')];
    await render({ current: rows, scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1');

    // The socket writer empties the live set; the surface must not blank.
    await render({ current: [], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1');

    await advanceBy(LIVE_SESSIONS_EMPTY_HOLD_MS - 1);
    expect(heldIds()).toBe('a1');

    // A genuinely empty live set is still reported once the window expires.
    await advanceBy(1);
    expect(heldIds()).toBe('');
  });

  it('retires the hold when the rows come back and keeps them past the window', async () => {
    await render({ current: [row('a1')], scopeKey: 'k1', canHold: true });
    await render({ current: [], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1');

    // The CLI reconnected before the window ended.
    await advanceBy(1000);
    await render({ current: [row('a1'), row('b2')], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1,b2');

    await advanceBy(LIVE_SESSIONS_EMPTY_HOLD_MS * 2);
    expect(heldIds()).toBe('a1,b2');
  });

  it('releases on its own schedule when the wall clock steps backwards', async () => {
    await render({ current: [row('a1')], scopeKey: 'k1', canHold: true });
    await render({ current: [], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1');

    // A device clock correction steps Date.now() backwards mid-window: the
    // hold must still end when its own window ends, not a step later.
    await advanceBy(1000);
    vi.setSystemTime(new Date(Date.now() - 60_000));
    await render({ current: [], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('a1');

    await advanceBy(LIVE_SESSIONS_EMPTY_HOLD_MS - 1000);
    expect(heldIds()).toBe('');
  });

  it('never holds across a context change or without read access', async () => {
    await render({ current: [row('a1')], scopeKey: 'k1', canHold: true });

    await render({ current: [], scopeKey: 'k2', canHold: true });
    expect(heldIds()).toBe('');

    await render({ current: [row('a1')], scopeKey: 'k2', canHold: true });
    await render({ current: [], scopeKey: 'k2', canHold: false });
    expect(heldIds()).toBe('');
  });

  it('does not delay an empty live set that was never populated', async () => {
    await render({ current: [], scopeKey: 'k1', canHold: true });
    expect(heldIds()).toBe('');

    await advanceBy(LIVE_SESSIONS_EMPTY_HOLD_MS);
    expect(heldIds()).toBe('');
  });
});
