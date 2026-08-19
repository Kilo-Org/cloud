import { describe, expect, it, vi } from 'vitest';
import { createWebMcpToolCall } from '@/src/shared/agent-conversation';
import { WEB_MCP_EXECUTE_MESSAGE } from '@/src/shared/tab-debugger';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: {
    runtime: { sendMessage: mocks.sendMessage },
  },
}));

// eslint-disable-next-line import/first
import { executeWebMcpToolCall } from './agent-web-mcp-tool-runtime';

const definitionSignature = '["double","Double","D","https://example.com",{}]';

const createEvent = () =>
  createWebMcpToolCall({
    arguments: { value: 21 },
    definitionSignature,
    documentId: 'doc-1',
    name: 'double',
    tabId: 7,
    webMcpOrigin: 'https://example.com',
  });

describe('webmcp tool executor', () => {
  it('parses a JSON string result into a structured value', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: '{"doubled":42}' },
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      ok: true,
      value: { doubled: 42 },
    });
  });

  it('keeps a non-JSON string result as a string', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: 'plain text result' },
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      ok: true,
      value: 'plain text result',
    });
  });

  it('returns a null result', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: null },
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
  });

  it('returns a non-ok background response as an error', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      error: 'tab closed',
      ok: false,
    });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      error: 'tab closed',
      ok: false,
    });
  });

  it('returns an invalid response as an error', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({ unexpected: true });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      error: 'Extension background returned an invalid response.',
      ok: false,
    });
  });

  it('returns a thrown sendMessage rejection as an error', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockRejectedValueOnce(new Error('background disconnected'));

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      error: 'background disconnected',
      ok: false,
    });
  });

  it('truncates a result longer than 64 KiB', async () => {
    mocks.sendMessage.mockReset();
    const huge = 'x'.repeat(64 * 1024 + 10);
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: huge },
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    await expect(executeWebMcpToolCall(createEvent())).resolves.toStrictEqual({
      ok: true,
      value: {
        truncated: true,
        value: JSON.stringify(huge).slice(0, 64 * 1024),
      },
    });
  });

  it('sends tabId, documentId, toolName, arguments, and definitionSignature', async () => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, value: '{"doubled":42}' },
      type: WEB_MCP_EXECUTE_MESSAGE,
    });

    await executeWebMcpToolCall(createEvent());

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      arguments: '{"value":21}',
      definitionSignature,
      documentId: 'doc-1',
      tabId: 7,
      toolName: 'double',
      type: WEB_MCP_EXECUTE_MESSAGE,
    });
  });
});
