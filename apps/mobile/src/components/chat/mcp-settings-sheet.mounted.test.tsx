/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMcpSettings } from '@/components/chat/mcp-settings-sheet';
import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

/**
 * The Kilo MCP switch when the move behind it fails.
 *
 * Flipping the switch writes the setting and then moves the live chat onto the
 * tool set it names, and either half can fail. The switch is optimistic, so the
 * failure has to put it back where it was and say why: a switch left on while
 * the session still holds the old tool set tells the person something untrue
 * and gives them nothing to act on.
 */

type Settings = ReturnType<typeof useMcpSettings>;

const setMcpEnabled = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const mcpEnabledFor = vi.hoisted(() =>
  vi.fn(async () => {
    await Promise.resolve();
    return true;
  })
);

/** One stable snapshot, because `useSyncExternalStore` compares by reference. */
const kiloState = vi.hoisted(() => ({
  current: { status: 'ready' as const, tools: [{}, {}, {}] },
}));

const held: { settings: Settings | undefined } = { settings: undefined };

function Harness({ sessionId }: { sessionId: string }) {
  held.settings = useMcpSettings(sessionId);
  return null;
}

vi.mock('react-native', () => ({ View: 'View' }));

vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

vi.mock('@/lib/chat/registry', () => ({
  retryKiloMcp: vi.fn(),
  setMcpEnabled,
}));

vi.mock('@/lib/chat/kilo-mcp', () => ({
  kiloMcpState: () => kiloState.current,
  mcpEnabledFor,
  watchKiloMcp: () => () => undefined,
}));

vi.mock('@/components/agents/session-page-sheet', () => ({ SessionPageSheet: 'SessionPageSheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Wrench: 'Wrench' }));
vi.mock('@/components/ui/preference-row', () => ({ PreferenceRow: 'PreferenceRow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: ReturnType<typeof TestRenderer.create> | undefined = undefined;

async function mount(): Promise<void> {
  renderer = TestRenderer.create(createElement(Harness, { sessionId: 's1' }));
  // The stored setting is read in an effect; let that read land before a tap.
  await act(async () => {
    await Promise.resolve();
  });
}

/** Flushes the tap and the promise the switch does not await. */
async function tap(next: boolean): Promise<void> {
  await act(async () => {
    held.settings?.setEnabled(next);
    await Promise.resolve();
  });
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  held.settings = undefined;
  vi.clearAllMocks();
  mcpEnabledFor.mockResolvedValue(true);
});

describe('the Kilo MCP switch', () => {
  it('keeps the new position when the write and the move land', async () => {
    setMcpEnabled.mockResolvedValue(undefined);
    await mount();

    await tap(false);

    expect(held.settings?.view.enabled).toBe(false);
    expect(setMcpEnabled).toHaveBeenCalledWith('s1', false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('goes back and says why when the chat cannot be moved', async () => {
    setMcpEnabled.mockRejectedValue(new Error('the chat could not be moved'));
    await mount();

    await tap(false);

    expect(held.settings?.view.enabled).toBe(true);
    expect(toastError).toHaveBeenCalledWith('the chat could not be moved');
  });

  it('says something went wrong when the failure carries no reason', async () => {
    setMcpEnabled.mockRejectedValue('no reason');
    await mount();

    await tap(false);

    expect(held.settings?.view.enabled).toBe(true);
    expect(toastError).toHaveBeenCalledWith(i18n.t('common.somethingWentWrong'));
  });
});
