import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_MESSAGE } from '@/src/shared/tab-debugger';
import { createToolCall } from '@/src/shared/agent-conversation';
import type { BrowserCaller } from '@/src/shared/browser-caller';
import {
  answerTabTakeOver,
  currentTabTakeOver,
  subscribeTabTakeOver,
} from './browser-tab-takeover';
import type { TabTakeOverPrompt } from './browser-tab-takeover';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    runtime: {
      sendMessage: mocks.sendMessage,
    },
  },
}));

// eslint-disable-next-line import/first
import { executeKiloBrowserToolCall } from './browser-tool-runtime';

const caller: BrowserCaller = {
  conversationId: 'conversation-1',
  kind: 'panel',
  panelId: 'panel-1',
};

const clickCall = () =>
  createToolCall({
    arguments: { target: 'e5' },
    name: 'kilo_browser_click',
    tabId: 7,
  });

const takeOverAsked = {
  ok: true,
  takeOver: {
    holderKind: 'agent',
    sessionTitle: 'Kilo CLI session Price check',
    tabId: 7,
  },
  type: BROWSER_TOOL_MESSAGE,
};

/** Resolves with the card the next take-over request shows. */
const nextCard = (): Promise<TabTakeOverPrompt> => {
  const { promise, resolve } = Promise.withResolvers<TabTakeOverPrompt>();
  const unsubscribe = subscribeTabTakeOver(() => {
    const shown = currentTabTakeOver();

    if (shown !== undefined) {
      unsubscribe();
      resolve(shown);
    }
  });

  return promise;
};

describe('side panel browser tool caller', () => {
  it('sends the tool name, arguments and caller identity verbatim and returns the background result', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'Clicked "e5".' },
      type: BROWSER_TOOL_MESSAGE,
    });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      ok: true,
      value: 'Clicked "e5".',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      arguments: { target: 'e5' },
      caller,
      safeMode: false,
      tabId: 7,
      takeOver: false,
      tool: 'kilo_browser_click',
      type: BROWSER_TOOL_MESSAGE,
    });
  });

  it('returns a background refusal as a tool error', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      error: 'The selected tab is not inspectable.',
      ok: false,
    });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'The selected tab is not inspectable.',
      ok: false,
    });
  });

  it('returns a failed inner dispatch result verbatim', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: {
        error: 'Invalid arguments for kilo_browser_click: missing required argument "target".',
        ok: false,
      },
      type: BROWSER_TOOL_MESSAGE,
    });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_click: missing required argument "target".',
      ok: false,
    });
  });

  it('re-sends with takeOver after the panel confirms, and leaves the agent call to end with tab_taken', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce(takeOverAsked).mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'Clicked "e5".' },
      type: BROWSER_TOOL_MESSAGE,
    });
    const card = nextCard();

    const call = executeKiloBrowserToolCall(clickCall(), caller);
    const shown = await card;

    expect(shown).toMatchObject({ sessionTitle: 'Kilo CLI session Price check', tabId: 7 });
    answerTabTakeOver(shown.requestId, true);

    await expect(call).resolves.toStrictEqual({ ok: true, value: 'Clicked "e5".' });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      arguments: { target: 'e5' },
      caller,
      safeMode: false,
      tabId: 7,
      takeOver: true,
      tool: 'kilo_browser_click',
      type: BROWSER_TOOL_MESSAGE,
    });
  });

  it('does not take the tab when the panel cancels the confirmation', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce(takeOverAsked);
    const card = nextCard();

    const call = executeKiloBrowserToolCall(clickCall(), caller);
    const shown = await card;

    answerTabTakeOver(shown.requestId, false);

    await expect(call).resolves.toStrictEqual({
      error:
        'The tab stays with Kilo CLI session Price check. Ask the user to stop that session or choose another tab.',
      ok: false,
    });
    // No second send with takeOver: the panel never took the tab.
    expect(mocks.sendMessage.mock.calls.at(1)).toBeUndefined();
  });

  it('ends the wait on the card when the turn stops, and a late Take over runs nothing', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce(takeOverAsked).mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'Clicked "e5".' },
      type: BROWSER_TOOL_MESSAGE,
    });
    const stop = new AbortController();
    const card = nextCard();

    const call = executeKiloBrowserToolCall(clickCall(), caller, stop.signal);
    const shown = await card;

    stop.abort();

    expect(currentTabTakeOver()).toBeUndefined();
    await expect(call).resolves.toStrictEqual({
      error: 'Stopped before the tab was taken over.',
      ok: false,
    });

    answerTabTakeOver(shown.requestId, true);
    await Promise.resolve();

    // Only the first send: the stopped call never asked the background to take the tab.
    expect(mocks.sendMessage.mock.calls.at(1)).toBeUndefined();
  });

  it('resolves to an error result when the background is unreachable', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.')
    );

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Could not establish connection. Receiving end does not exist.',
      ok: false,
    });
  });

  it('resolves to an error result when the background sends no answer', async () => {
    mocks.sendMessage.mockReset();
    // Chrome resolves with no answer (no listener) instead of rejecting.
    mocks.sendMessage.mockResolvedValueOnce(null);

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Extension background returned an invalid response.',
      ok: false,
    });
  });

  it('resolves to an error result for a malformed response', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({ totally: 'wrong' });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Extension background returned an invalid response.',
      ok: false,
    });
  });

  it('resolves to an error result for a response of the wrong message type', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'x' },
      type: 'kilo.tabs.eval',
    });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Extension background returned the wrong response.',
      ok: false,
    });
  });

  it('resolves to an error result when the message send throws a non-Error value', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce('transport gone');

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error: 'Failed to run the browser tool.',
      ok: false,
    });
  });
});
