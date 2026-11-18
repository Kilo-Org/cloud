import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_MESSAGE } from '@/src/shared/tab-debugger';
import { createToolCall } from '@/src/shared/agent-conversation';
import type { BrowserCaller } from '@/src/shared/browser-caller';

const mocks = vi.hoisted(() => ({
  requestTabTakeOver: vi.fn(),
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

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('./browser-tab-takeover', () => ({
  requestTabTakeOver: mocks.requestTabTakeOver,
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
    mocks.requestTabTakeOver.mockReset();
    mocks.requestTabTakeOver.mockResolvedValueOnce(true);
    mocks.sendMessage
      .mockResolvedValueOnce({
        ok: true,
        takeOver: {
          holderKind: 'agent',
          sessionTitle: 'Kilo CLI session Price check',
          tabId: 7,
        },
        type: BROWSER_TOOL_MESSAGE,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { ok: true, value: 'Clicked "e5".' },
        type: BROWSER_TOOL_MESSAGE,
      });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      ok: true,
      value: 'Clicked "e5".',
    });
    expect(mocks.requestTabTakeOver).toHaveBeenCalledWith({
      sessionTitle: 'Kilo CLI session Price check',
      tabId: 7,
    });
    expect(mocks.sendMessage).toHaveBeenLastCalledWith({
      arguments: { target: 'e5' },
      caller,
      tabId: 7,
      takeOver: true,
      tool: 'kilo_browser_click',
      type: BROWSER_TOOL_MESSAGE,
    });
  });

  it('does not take the tab when the panel cancels the confirmation', async () => {
    mocks.sendMessage.mockReset();
    mocks.requestTabTakeOver.mockReset();
    mocks.requestTabTakeOver.mockResolvedValueOnce(false);
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      takeOver: {
        holderKind: 'agent',
        sessionTitle: 'Kilo CLI session Price check',
        tabId: 7,
      },
      type: BROWSER_TOOL_MESSAGE,
    });

    await expect(executeKiloBrowserToolCall(clickCall(), caller)).resolves.toStrictEqual({
      error:
        'The tab stays with Kilo CLI session Price check. Ask the user to stop that session or choose another tab.',
      ok: false,
    });
    // No second send with takeOver: the panel never took the tab.
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
