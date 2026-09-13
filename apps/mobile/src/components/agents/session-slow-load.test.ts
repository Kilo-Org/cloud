/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount hooks under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolveSessionLoadPhase,
  SESSION_SLOW_LOAD_MS,
  type SessionLoadPhase,
  type SessionLoadPhaseInput,
  type SessionSlowLoadPhaseInput,
  useSessionSlowLoadPhase,
} from '@/components/agents/session-slow-load';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const BASE: SessionLoadPhaseInput = {
  isLoading: true,
  hasContent: false,
  hasError: false,
  hasStatusIndicator: false,
  elapsedMs: 0,
};

describe('resolveSessionLoadPhase', () => {
  it('stays loading below the slow threshold', () => {
    expect(resolveSessionLoadPhase({ ...BASE, elapsedMs: SESSION_SLOW_LOAD_MS - 1 })).toBe(
      'loading'
    );
  });

  it('flips to slow at the threshold with no content, error or progress indicator', () => {
    expect(resolveSessionLoadPhase({ ...BASE, elapsedMs: SESSION_SLOW_LOAD_MS })).toBe('slow');
  });

  it('stays slow past the threshold', () => {
    expect(resolveSessionLoadPhase({ ...BASE, elapsedMs: SESSION_SLOW_LOAD_MS * 5 })).toBe('slow');
  });

  it('reports content as soon as content exists, even past the threshold', () => {
    expect(
      resolveSessionLoadPhase({
        ...BASE,
        hasContent: true,
        elapsedMs: SESSION_SLOW_LOAD_MS * 5,
      })
    ).toBe('content');
  });

  it('reports failed for an error, even past the threshold', () => {
    expect(
      resolveSessionLoadPhase({
        ...BASE,
        hasError: true,
        elapsedMs: SESSION_SLOW_LOAD_MS * 5,
      })
    ).toBe('failed');
  });

  it('never reports slow while a progress status indicator is visible', () => {
    expect(
      resolveSessionLoadPhase({
        ...BASE,
        hasStatusIndicator: true,
        elapsedMs: SESSION_SLOW_LOAD_MS * 5,
      })
    ).not.toBe('slow');
  });

  it('never reports slow once loading has settled without content', () => {
    expect(
      resolveSessionLoadPhase({
        ...BASE,
        isLoading: false,
        elapsedMs: SESSION_SLOW_LOAD_MS * 5,
      })
    ).not.toBe('slow');
  });

  it('prefers a terminal failure over content and slow', () => {
    expect(
      resolveSessionLoadPhase({
        ...BASE,
        hasContent: true,
        hasError: true,
        elapsedMs: SESSION_SLOW_LOAD_MS,
      })
    ).toBe('failed');
  });
});

async function renderPhaseHook(makeInput: () => SessionSlowLoadPhaseInput): Promise<{
  phase: () => SessionLoadPhase;
  rerender: () => void;
  unmount: () => void;
}> {
  let phase: SessionLoadPhase = 'loading';
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  function Probe() {
    phase = useSessionSlowLoadPhase(makeInput());
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(createElement(Probe));
    await Promise.resolve();
  });
  return {
    phase: () => phase,
    rerender: () => {
      act(() => {
        renderer?.update(createElement(Probe));
      });
    },
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

describe('useSessionSlowLoadPhase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const STALLED: SessionSlowLoadPhaseInput = {
    isLoading: true,
    hasContent: false,
    hasError: false,
    hasStatusIndicator: false,
  };

  it('stays loading just short of the threshold and flips slow at it', async () => {
    const probe = await renderPhaseHook(() => STALLED);
    act(() => {
      vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS - 1);
    });
    probe.rerender();
    expect(probe.phase()).toBe('loading');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(probe.phase()).toBe('slow');
    probe.unmount();
  });

  it('measures the threshold from openStartedAt, not from stall start', async () => {
    // The open began 20 s ago (a slow metadata round trip ahead of this
    // surface mounting): only the remaining 10 s of grace are left.
    vi.setSystemTime(20_000);
    const probe = await renderPhaseHook(() => ({ ...STALLED, openStartedAt: 0 }));
    act(() => {
      vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS - 20_000 - 1);
    });
    probe.rerender();
    expect(probe.phase()).toBe('loading');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(probe.phase()).toBe('slow');
    probe.unmount();
  });

  it('flags slow immediately when the anchored threshold already passed', async () => {
    vi.setSystemTime(SESSION_SLOW_LOAD_MS + 5000);
    const probe = await renderPhaseHook(() => ({ ...STALLED, openStartedAt: 0 }));
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(probe.phase()).toBe('slow');
    probe.unmount();
  });

  it('clears the pending threshold when content arrives', async () => {
    let input: SessionSlowLoadPhaseInput = STALLED;
    const probe = await renderPhaseHook(() => input);
    act(() => {
      vi.advanceTimersByTime(SESSION_SLOW_LOAD_MS - 5000);
      input = { ...STALLED, hasContent: true };
    });
    probe.rerender();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    probe.rerender();
    expect(probe.phase()).toBe('content');
    probe.unmount();
  });
});
