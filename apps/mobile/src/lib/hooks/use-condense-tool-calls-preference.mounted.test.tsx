import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { type useCondenseToolCallsPreference } from './use-condense-tool-calls-preference';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

const KEY = 'condense-tool-calls';

type PreferenceHook = typeof useCondenseToolCallsPreference;

const renderers: TestRenderer.ReactTestRenderer[] = [];

/**
 * Mounting the hook is what starts the store's disk read: no other export of
 * the module starts it. The probe prints the value and the load flag, so a case
 * can wait for the read to land.
 */
function Probe({ usePreference }: { usePreference: PreferenceHook }) {
  const { condenseToolCalls, hasLoaded } = usePreference();
  return createElement('ProbeText', null, `${String(condenseToolCalls)}:${String(hasLoaded)}`);
}

async function renderProbe(usePreference: PreferenceHook): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe, { usePreference }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return renderer;
}

/** The probe's `value:hasLoaded` text, for example `'false:true'`. */
function probeText(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
    throw new Error('probe rendered no text');
  }
  return json.children.filter((child): child is string => typeof child === 'string').join('');
}

describe('parseCondenseToolCalls', () => {
  it('defaults to on for a missing value (fresh install and unreadable read)', async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls(null)).toBe(true);
  });

  it("reads 'true' as on", async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('true')).toBe(true);
  });

  it("reads 'false' as off", async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('false')).toBe(false);
  });

  it('treats any other stored string as off', async () => {
    const { parseCondenseToolCalls } = await import('./use-condense-tool-calls-preference');
    expect(parseCondenseToolCalls('')).toBe(false);
    expect(parseCondenseToolCalls('nonsense')).toBe(false);
  });
});

describe('condense-tool-calls store', () => {
  beforeEach(() => {
    vi.resetModules();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    deleteItemAsync.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
  });

  it('defaults to on when SecureStore returns null (the shipped default)', async () => {
    getItemAsync.mockResolvedValue(null);
    const { getCondenseToolCalls, useCondenseToolCallsPreference } =
      await import('./use-condense-tool-calls-preference');
    const renderer = await renderProbe(useCondenseToolCallsPreference);

    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('true:true');
    });
    expect(getCondenseToolCalls()).toBe(true);
  });

  it("reads the stored string 'true' as on", async () => {
    getItemAsync.mockResolvedValue('true');
    const { getCondenseToolCalls, useCondenseToolCallsPreference } =
      await import('./use-condense-tool-calls-preference');
    const renderer = await renderProbe(useCondenseToolCallsPreference);

    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('true:true');
    });
    expect(getCondenseToolCalls()).toBe(true);
  });

  it("reads the stored string 'false' as off", async () => {
    getItemAsync.mockResolvedValue('false');
    const { getCondenseToolCalls, useCondenseToolCallsPreference } =
      await import('./use-condense-tool-calls-preference');
    const renderer = await renderProbe(useCondenseToolCallsPreference);

    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('false:true');
    });
    expect(getCondenseToolCalls()).toBe(false);
  });

  it('setCondenseToolCalls persists true and false under condense-tool-calls', async () => {
    getItemAsync.mockResolvedValue(null);
    const { setCondenseToolCalls } = await import('./use-condense-tool-calls-preference');

    setCondenseToolCalls(true);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledWith(KEY, 'true');
    });

    setCondenseToolCalls(false);
    await vi.waitFor(() => {
      expect(setItemAsync).toHaveBeenCalledWith(KEY, 'false');
    });
  });

  it('clearCondenseToolCallsPreference deletes the key', async () => {
    getItemAsync.mockResolvedValue(null);
    const { clearCondenseToolCallsPreference } =
      await import('./use-condense-tool-calls-preference');

    clearCondenseToolCallsPreference();
    await vi.waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith(KEY);
    });
  });

  it('clearCondenseToolCallsPreference resets the value to on and deletes the key', async () => {
    getItemAsync.mockResolvedValue('true');
    const {
      clearCondenseToolCallsPreference,
      getCondenseToolCalls,
      useCondenseToolCallsPreference,
    } = await import('./use-condense-tool-calls-preference');
    const renderer = await renderProbe(useCondenseToolCallsPreference);

    await vi.waitFor(() => {
      expect(probeText(renderer)).toBe('true:true');
    });

    clearCondenseToolCallsPreference();

    await vi.waitFor(() => {
      expect(deleteItemAsync).toHaveBeenCalledWith(KEY);
    });
    // The stored choice is gone, so the shipped default shows again.
    expect(getCondenseToolCalls()).toBe(true);
  });

  it('toasts common.couldNotSaveSetting and keeps the on default when the write fails', async () => {
    getItemAsync.mockResolvedValue(null);
    setItemAsync.mockRejectedValue(new Error('disk full'));
    const { getCondenseToolCalls, setCondenseToolCalls } =
      await import('./use-condense-tool-calls-preference');

    setCondenseToolCalls(true);

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Could not save setting');
    });
    // The failed choice was dropped, so the value is the shipped default.
    expect(getCondenseToolCalls()).toBe(true);
  });
});
