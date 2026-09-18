import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from './tool-summary-translation-runtime';
import {
  TOOL_SUMMARY_TRANSLATION_RETRY_MS,
  type ToolSummaryTranslation,
  useToolSummaryTranslation,
  useTranslatedToolSummary,
} from './use-translated-tool-summary';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'de' } }) }));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function Probe({
  text,
  enabled,
  onRender,
}: {
  text: string;
  enabled?: boolean;
  onRender: (value: string) => void;
}) {
  const translated = useTranslatedToolSummary(text, enabled);
  onRender(translated);
  return null;
}

function mount(text: string, enabled?: boolean): { latest: () => string; unmount: () => void } {
  let current = '';
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(Probe, {
        text,
        enabled,
        onRender: value => {
          current = value;
        },
      })
    );
  });
  return {
    latest: () => current,
    unmount: () => {
      act(() => {
        renderer?.unmount();
      });
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the dynamic import and request
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useTranslatedToolSummary', () => {
  it('renders the raw text when the preference is off', async () => {
    requestMock.mockResolvedValue('translated');
    setConfig({ enabled: false, model: MODEL });
    const { latest, unmount } = mount('Off summary');

    await settle();

    expect(latest()).toBe('Off summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('renders the raw text when disabled for this row', async () => {
    requestMock.mockResolvedValue('translated');
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Row-disabled summary', false);

    await settle();

    expect(latest()).toBe('Row-disabled summary');
    expect(requestMock).not.toHaveBeenCalled();
    unmount();
  });

  it('shows the translation once it resolves', async () => {
    requestMock.mockResolvedValue('Bonjour');
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Hello');

    expect(latest()).toBe('Hello');
    await settle();

    expect(latest()).toBe('Bonjour');
    unmount();
  });

  it('keeps the raw text when the client rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mount('Uncached summary');

    await settle();

    expect(latest()).toBe('Uncached summary');
    unmount();
  });
});

/** Advance the fake clock and let the pending import/request microtasks settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
}

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
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      createElement(PendingProbe, {
        text,
        onRender: value => {
          current = value;
        },
      })
    );
  });
  return {
    latest: () => current,
    unmount: () => {
      act(() => {
        renderer?.unmount();
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
    vi.useRealTimers();
  });

  it('stays pending after a failed request and resolves once a retry succeeds', async () => {
    requestMock.mockResolvedValueOnce(null).mockResolvedValue('Bonjour');
    setConfig({ enabled: true, model: MODEL });
    // A summary no sibling test cached, so the first request really is made.
    const { latest, unmount } = mountPending('Retry target summary');

    await advance(0);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(latest()).toEqual({ text: 'Retry target summary', pending: true });

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(latest()).toEqual({ text: 'Bonjour', pending: false });
    unmount();
  });

  it('stops retrying once the translation lands', async () => {
    requestMock.mockResolvedValueOnce(null).mockResolvedValue('Bonjour');
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountPending('Resolved target summary');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(latest().text).toBe('Bonjour');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS * 3);
    expect(requestMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('stops retrying when the row unmounts', async () => {
    requestMock.mockResolvedValue(null);
    setConfig({ enabled: true, model: MODEL });
    const { latest, unmount } = mountPending('Unmounted target summary');

    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(latest()).toEqual({ text: 'Unmounted target summary', pending: true });

    unmount();
    await advance(TOOL_SUMMARY_TRANSLATION_RETRY_MS * 3);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
