/* eslint-disable max-lines -- the string-row states and the pending/shared-retry suite share one hook and one client mock harness. */
import { onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { retryUnresolvedTranslations, setConfig } from './tool-summary-translation-runtime';
import {
  TOOL_SUMMARY_TRANSLATION_RETRY_MS,
  type ToolSummaryTranslation,
  useToolSummaryTranslation,
  useTranslatedToolSummary,
} from './use-translated-tool-summary';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
// The encrypted-KV cache is a native module; the runtime loads it by dynamic
// import, so the suite mocks it the same way it mocks the client.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'de' } }) }));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

type ProbeSpec = { text: string; enabled?: boolean; itemId?: string };

function Probe({
  text,
  enabled,
  itemId,
  onRender,
}: {
  text: string;
  enabled?: boolean;
  itemId?: string;
  onRender: (value: string) => void;
}) {
  const translated = useTranslatedToolSummary(text, enabled, itemId);
  onRender(translated);
  return null;
}

function mountProbes(specs: ProbeSpec[]): {
  latest: (index: number) => string;
  unmount: () => void;
} {
  const current: string[] = specs.map(() => '');
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(
      createElement(
        'View',
        null,
        ...specs.map((spec, index) =>
          createElement(Probe, {
            text: spec.text,
            enabled: spec.enabled,
            itemId: spec.itemId,
            onRender: value => {
              current[index] = value;
            },
          })
        )
      )
    );
  });
  const renderer = ref.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return {
    latest: index => current[index] ?? '',
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

function mount(spec: ProbeSpec): { latest: () => string; unmount: () => void } {
  const probes = mountProbes([spec]);
  return { latest: () => probes.latest(0), unmount: probes.unmount };
}

function requestedTexts(callIndex: number): readonly string[] {
  return (
    (requestMock.mock.calls[callIndex]?.[0] as { texts: readonly string[] } | undefined)?.texts ??
    []
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- real time for the batch window, then the macrotask that settles the dynamic import and request
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20);
      });
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
});

describe('useTranslatedToolSummary', () => {
  it('renders the raw text when the preference is off', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: false, model: MODEL });
    const { latest, unmount } = mount({ text: 'Off summary', itemId: 'part-1' });

    await settle();

    expect(latest()).toBe('Off summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the raw text when disabled for this row', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({
      text: 'Row-disabled summary',
      enabled: false,
      itemId: 'part-1',
    });

    await settle();

    expect(latest()).toBe('Row-disabled summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('never requests a translation for a row without an item id', async () => {
    requestMock.mockResolvedValue(['translated']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'No id summary' });

    await settle();

    expect(latest()).toBe('No id summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the translation once it resolves', async () => {
    requestMock.mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'Hello', itemId: 'part-1' });

    expect(latest()).toBe('Hello');
    await settle();

    expect(latest()).toBe('Bonjour');
    unmount();
  });

  it('keeps the raw text when the client rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount({ text: 'Uncached summary', itemId: 'part-1' });

    await settle();

    expect(latest()).toBe('Uncached summary');
    unmount();
  });

  it('resolves two rows with the same text but different ids from one batch', async () => {
    requestMock.mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountProbes([
      { text: 'Same greeting', itemId: 'part-a' },
      { text: 'Same greeting', itemId: 'part-b' },
    ]);

    await settle();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest(0)).toBe('Bonjour');
    expect(latest(1)).toBe('Bonjour');
    // Each id owns its own persisted entry, so the rows never share a key.
    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(2);
    });
    const writtenIds = writeMock.mock.calls
      .map(call => (call[0] as { itemId: string }).itemId)
      .toSorted();
    expect(writtenIds).toEqual(['part-a', 'part-b']);
    unmount();
  });

  it('gives two probes with the same id and different texts their own translations', async () => {
    // The row and the detail sheet resolve different source strings under the
    // same part id: each must show its own translation, not evict the other.
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/require-await -- the mock answers the batch synchronously
      async ({ texts }: { texts: readonly string[] }) => texts.map(text => `de:${text}`)
    );
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountProbes([
      { text: 'Row label', itemId: 'part-1' },
      { text: 'Sheet text', itemId: 'part-1' },
    ]);

    await settle();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest(0)).toBe('de:Row label');
    expect(latest(1)).toBe('de:Sheet text');
    unmount();
  });

  it('releases only the interest of the surface whose text changed', async () => {
    // The row and the sheet both show the streaming string while the gateway is
    // unreachable, so the failed text stays remembered for a reconnect. Only
    // the first surface's text settles: its cleanup must release its own
    // interest, not the sheet's, so the sheet's copy is still re-requested.
    // Once the sheet settles too no surface asks for the streaming string any
    // more, and a reconnect must not re-send it.
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/require-await -- the mock answers the batch synchronously
      async ({ texts }: { texts: readonly string[] }) => {
        if (texts.includes('partial')) {
          throw new Error('gateway down');
        }
        return texts.map(text => `de:${text}`);
      }
    );
    setConfig({ enabled: true, model: MODEL });
    const current: string[] = ['', ''];
    const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
    const probe = (text: string, index: number) =>
      createElement(Probe, {
        text,
        itemId: 'part-1',
        onRender: value => {
          current[index] = value;
        },
      });
    act(() => {
      ref.renderer = TestRenderer.create(
        createElement('View', null, probe('partial', 0), probe('partial', 1))
      );
    });
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Only the first surface's text settles: its effect re-runs, the second
    // surface's does not.
    act(() => {
      ref.renderer?.update(createElement('View', null, probe('final', 0), probe('partial', 1)));
    });
    await settle();

    expect(current[0]).toBe('de:final');
    expect(current[1]).toBe('partial');

    // The sheet still asks for the streaming string, so a reconnect must still
    // re-send it.
    act(() => {
      retryUnresolvedTranslations();
    });
    await settle();
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(requestedTexts(2)).toEqual(['partial']);

    // The sheet settles too. No surface asks for the streaming string any more,
    // so it must be dropped: the reconnect below re-sends nothing.
    act(() => {
      ref.renderer?.update(createElement('View', null, probe('final', 0), probe('final', 1)));
    });
    await settle();
    act(() => {
      retryUnresolvedTranslations();
    });
    await settle();

    expect(current[1]).toBe('de:final');
    expect(requestMock).toHaveBeenCalledTimes(3);
    act(() => {
      ref.renderer?.unmount();
    });
  });
});

/** Advance the fake clock and let the pending import/request microtasks settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
}

/**
 * Longer than the runtime's 40 ms batch window: a summary the row asked for has
 * left the window and its request has been issued. The row's own retry cadence
 * (`TOOL_SUMMARY_TRANSLATION_RETRY_MS`) starts the next request, which needs its
 * own window before it is dispatched.
 */
const BATCH_WINDOW_SETTLE_MS = 60;

function PendingProbe({
  text,
  onRender,
}: {
  text: string;
  onRender: (value: ToolSummaryTranslation) => void;
}) {
  onRender(useToolSummaryTranslation(text));
  return null;
}

function mountPending(text: string): { latest: () => ToolSummaryTranslation; unmount: () => void } {
  let current: ToolSummaryTranslation = { text: '', pending: false };
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(
      createElement(PendingProbe, {
        text,
        onRender: value => {
          current = value;
        },
      })
    );
  });
  const renderer = ref.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return {
    latest: () => current,
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

/**
 * A request that settled without a translation (every client failure resolves
 * to `null` and caches nothing) must not be final: the row keeps asking while
 * it stays mounted, so a transient gateway failure resolves once the gateway
 * recovers instead of holding the fallback for the rest of the mount.
 */
describe('useToolSummaryTranslation retries an unresolved summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // The connectivity gate is module-global: a case that flips it must restore
    // it before the next one runs, or the shared retry stays paused.
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  it('stays pending after a failed request and resolves once a retry succeeds', async () => {
    // One entry per text of the request: the first batch fails, the retry
    // resolves.
    requestMock.mockResolvedValueOnce([null]).mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    // A summary no sibling test cached, so the first request really is made.
    const { latest, unmount } = mountPending('Retry target summary');

    await advance(BATCH_WINDOW_SETTLE_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest()).toEqual({ text: 'Retry target summary', pending: true });

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(latest()).toEqual({ text: 'Bonjour', pending: false });
    unmount();
  });

  it('stops retrying once the translation lands', async () => {
    // One entry per text of the request: the first batch fails, the retry
    // resolves.
    requestMock.mockResolvedValueOnce([null]).mockResolvedValue(['Bonjour']);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountPending('Resolved target summary');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS + BATCH_WINDOW_SETTLE_MS);
    expect(latest().text).toBe('Bonjour');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS * 3);
    expect(requestMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('stops retrying when the row unmounts', async () => {
    requestMock.mockResolvedValue([null]);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountPending('Unmounted target summary');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS + BATCH_WINDOW_SETTLE_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(latest()).toEqual({ text: 'Unmounted target summary', pending: true });

    unmount();
    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS * 3);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('arms one shared timer instead of an interval per mounted row', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    requestMock.mockResolvedValue([null]);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountProbes([
      { text: 'Shared retry one', itemId: 'part-a' },
      { text: 'Shared retry two', itemId: 'part-b' },
      { text: 'Shared retry three', itemId: 'part-c' },
    ]);

    await advance(BATCH_WINDOW_SETTLE_MS);

    // Every row is unresolved, yet the fix must never arm a per-row interval.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest(0)).toBe('Shared retry one');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    unmount();
    setIntervalSpy.mockRestore();
  });

  it('doubles the wait after each replay', async () => {
    requestMock.mockResolvedValue([null]);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountPending('Backoff target summary');

    await advance(BATCH_WINDOW_SETTLE_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The first replay is still at the base delay.
    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(latest()).toEqual({ text: 'Backoff target summary', pending: true });

    // The next wake is at 2x the base: one base window later nothing new.
    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('pauses the shared retry while offline and replays once on reconnect', async () => {
    requestMock.mockResolvedValue([null]);
    setConfig({ enabled: true, model: MODEL });
    // Offline before the failure: the shared timer must not wake, and the
    // reconnection edge below must be the only thing that resumes it.
    onlineManager.setOnline(false);
    const { latest, unmount } = mountPending('Offline target summary');

    await advance(BATCH_WINDOW_SETTLE_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS * 2);
    // No wakeup and no gateway call while offline: only the mount request.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest()).toEqual({ text: 'Offline target summary', pending: true });

    onlineManager.setOnline(true);
    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS + BATCH_WINDOW_SETTLE_MS);
    // Exactly one replay on the reconnection edge, at the base delay.
    expect(requestMock).toHaveBeenCalledTimes(2);
    unmount();
  });
});
