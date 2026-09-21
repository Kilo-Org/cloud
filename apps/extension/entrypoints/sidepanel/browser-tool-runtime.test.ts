import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_MESSAGE } from '@/src/shared/tab-debugger';
import { createToolCall } from '@/src/shared/agent-conversation';

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

const clickCall = () =>
  createToolCall({
    arguments: { target: 'e5' },
    name: 'kilo_browser_click',
    tabId: 7,
  });

describe('side panel browser tool caller', () => {
  it('sends the tool name and arguments verbatim and returns the background result', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'Clicked "e5".' },
      type: BROWSER_TOOL_MESSAGE,
    });

    const toolCall = clickCall();

    await expect(executeKiloBrowserToolCall(toolCall)).resolves.toStrictEqual({
      ok: true,
      value: 'Clicked "e5".',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      arguments: { target: 'e5' },
      tabId: 7,
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

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
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

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_click: missing required argument "target".',
      ok: false,
    });
  });

  it('resolves to an error result when the background is unreachable', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.')
    );

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
      error: 'Could not establish connection. Receiving end does not exist.',
      ok: false,
    });
  });

  it('resolves to an error result when the background sends no answer', async () => {
    mocks.sendMessage.mockReset();
    // Chrome resolves with no answer (no listener) instead of rejecting.
    mocks.sendMessage.mockResolvedValueOnce(null);

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
      error: 'Extension background returned an invalid response.',
      ok: false,
    });
  });

  it('resolves to an error result for a malformed response', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({ totally: 'wrong' });

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
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

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
      error: 'Extension background returned the wrong response.',
      ok: false,
    });
  });

  it('resolves to an error result when the message send throws a non-Error value', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce('transport gone');

    await expect(executeKiloBrowserToolCall(clickCall())).resolves.toStrictEqual({
      error: 'Failed to run the browser tool.',
      ok: false,
    });
  });
});
