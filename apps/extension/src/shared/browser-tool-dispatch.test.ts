/* eslint-disable max-lines, require-await, typescript-eslint/require-await, unicorn/no-useless-undefined -- Fake browser-tool session returns verbatim responses for assertions. */
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_CONTRACT } from './browser-tool-contract';
import {
  BROWSER_TOOL_HANDLERS,
  assertBrowserToolHandlerCoverage,
  getBrowserToolHandlerCoverage,
  runKiloBrowserTool,
} from './browser-tool-dispatch';
import type { BrowserToolDispatchSession } from './browser-tool-dispatch';
import { createBrowserToolSession } from './browser-tool-session';
import type { BrowserToolCallResult } from './browser-tool-session';
import type { BrowserScriptingApi, BrowserTabsApi } from './tab-debugger';

interface FakeSession extends BrowserToolDispatchSession {
  readonly commands: string[];
}

const createFakeSession = (unavailableError?: string): FakeSession => {
  const commands: string[] = [];

  return {
    attach: async () => {},
    backend: 'debugger',
    callTool: async (): Promise<BrowserToolCallResult> => ({ ok: true, value: undefined }),
    commands,
    consoleMessages: () => [],
    dispose: async () => {},
    getToolUnavailableError: () => unavailableError,
    networkRequestsSinceLoad: () => [],
    registerRefs: () => {},
    resolveTarget: vi.fn(async () => undefined),
    send: async method => {
      commands.push(method);

      return {};
    },
    takeDialog: () => undefined,
  };
};

interface FakeScriptingSession extends BrowserToolDispatchSession {
  readonly commands: string[];
  readonly toolCalls: { args: Record<string, unknown> | undefined; tool: string }[];
}

/**
 * A session whose factory selected the scripting backend (Firefox): `send`
 * throws the way `browser-tool-session.ts` does without `debuggerApi`, so only
 * `callTool` can run a tool.
 */
const createScriptingFakeSession = (
  callToolResult?: BrowserToolCallResult,
  unavailableError?: string
): FakeScriptingSession => {
  const commands: string[] = [];
  const toolCalls: { args: Record<string, unknown> | undefined; tool: string }[] = [];

  return {
    attach: async () => {},
    backend: 'scripting',
    callTool: async (tool, args): Promise<BrowserToolCallResult> => {
      toolCalls.push({ args, tool });

      return callToolResult ?? { ok: true, value: undefined };
    },
    commands,
    consoleMessages: () => [],
    dispose: async () => {},
    getToolUnavailableError: () => unavailableError,
    networkRequestsSinceLoad: () => [],
    registerRefs: () => {},
    resolveTarget: vi.fn(async () => undefined),
    send: async () => {
      commands.push('send');

      throw new Error(
        'send is not available in Firefox: this browser exposes no debugger protocol. Use session.callTool for the browser tools.'
      );
    },
    takeDialog: () => undefined,
    toolCalls,
  };
};

describe('browser tool dispatch coverage', () => {
  it('covers every contract entry with a handler and no handler without a contract entry', () => {
    expect(BROWSER_TOOL_CONTRACT).toHaveLength(26);
    expect(Object.keys(BROWSER_TOOL_HANDLERS)).toHaveLength(BROWSER_TOOL_CONTRACT.length);

    const coverage = getBrowserToolHandlerCoverage();

    expect(coverage.contractToolsWithoutHandler).toStrictEqual([]);
    expect(coverage.handlersWithoutContract).toStrictEqual([]);

    expect(() => {
      assertBrowserToolHandlerCoverage();
    }).not.toThrow();
  });
});

describe('runKiloBrowserTool dispatch', () => {
  it('runs a happy call through the family handler with the model-facing kilo_ name', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({
        arguments: { height: 600, width: 800 },
        session,
        toolName: 'kilo_browser_resize',
      })
    ).resolves.toStrictEqual({ ok: true, value: { height: 600, width: 800 } });
    expect(session.commands).toStrictEqual(['Emulation.setDeviceMetricsOverride']);
  });

  it('accepts the upstream browser_ name too', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({
        arguments: { height: 100, width: 200 },
        session,
        toolName: 'browser_resize',
      })
    ).resolves.toStrictEqual({ ok: true, value: { height: 100, width: 200 } });
  });
});

describe('runKiloBrowserTool on the scripting backend', () => {
  it('routes the validated arguments through session.callTool instead of the debugger family handler', async () => {
    const session = createScriptingFakeSession({ ok: true, value: 'Clicked "e1".' });

    await expect(
      runKiloBrowserTool({
        arguments: { target: 'e1' },
        session,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({ ok: true, value: 'Clicked "e1".' });

    // The family handler's `send` throws on the scripting backend, so it must not run; callTool is the reachable path.
    expect(session.commands).toStrictEqual([]);
    expect(session.toolCalls).toStrictEqual([
      { args: { target: 'e1' }, tool: 'kilo_browser_click' },
    ]);
  });

  it('returns a scripting callTool error verbatim', async () => {
    const session = createScriptingFakeSession({ error: 'The target ref is stale.', ok: false });

    await expect(
      runKiloBrowserTool({ arguments: { target: 'e9' }, session, toolName: 'kilo_browser_click' })
    ).resolves.toStrictEqual({ error: 'The target ref is stale.', ok: false });
    expect(session.commands).toStrictEqual([]);
  });

  it('still validates arguments against the contract before reaching callTool', async () => {
    const session = createScriptingFakeSession({ ok: true, value: 'x' });

    await expect(
      runKiloBrowserTool({
        arguments: { bogus: true },
        session,
        toolName: 'kilo_browser_snapshot',
      })
    ).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_snapshot: unknown argument "bogus".',
      ok: false,
    });
    expect(session.toolCalls).toStrictEqual([]);
  });

  it('returns the platform gate without touching callTool for a tool Firefox cannot express', async () => {
    const session = createScriptingFakeSession(
      { ok: true, value: 'x' },
      'kilo_browser_console_messages is not available in Firefox: this browser exposes no debugger protocol.'
    );

    await expect(
      runKiloBrowserTool({
        arguments: { level: 'info' },
        session,
        toolName: 'kilo_browser_console_messages',
      })
    ).resolves.toStrictEqual({
      error:
        'kilo_browser_console_messages is not available in Firefox: this browser exposes no debugger protocol.',
      ok: false,
    });
    expect(session.toolCalls).toStrictEqual([]);
  });
});

/*
 * The real session module factory selects the scripting backend when
 * `debuggerApi` is absent. These fakes stand in for `browser.scripting` and
 * `browser.tabs` so the dispatch is exercised end to end over that backend,
 * not just over the hand-built session doubles above.
 */
const createScriptingApi = (value: unknown): BrowserScriptingApi => ({
  executeScript: () => [
    { documentId: 'doc-1', result: { ok: true, value: { done: true, result: value } } },
  ],
});

const createTabsApi = (): BrowserTabsApi => ({
  get: async tabId => ({ id: tabId, title: 'Example', url: 'https://example.com/' }),
  onRemoved: { addListener: () => {}, removeListener: () => {} },
  query: async () => [],
});

describe('runKiloBrowserTool over the session factory scripting backend', () => {
  it('runs an expressible tool through callTool instead of failing on the missing debugger protocol', async () => {
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi('Clicked #submit with the left button.'),
      tabId: 7,
      tabsApi: createTabsApi(),
    });

    expect(session.backend).toBe('scripting');

    await expect(
      runKiloBrowserTool({
        arguments: { target: '#submit' },
        session,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({ ok: true, value: 'Clicked #submit with the left button.' });
  });

  it('still refuses a debugger-only tool by name on the scripting backend', async () => {
    const session = createBrowserToolSession({
      scriptingApi: createScriptingApi('unused'),
      tabId: 7,
      tabsApi: createTabsApi(),
    });

    await expect(
      runKiloBrowserTool({
        arguments: {},
        session,
        toolName: 'kilo_browser_network_requests',
      })
    ).resolves.toStrictEqual({
      error:
        'kilo_browser_network_requests is not available in Firefox: this browser exposes no debugger protocol.',
      ok: false,
    });
  });
});

describe('runKiloBrowserTool argument validation', () => {
  it('rejects missing required arguments, naming the tool and the field', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({ arguments: {}, session, toolName: 'kilo_browser_resize' })
    ).resolves.toStrictEqual({
      error:
        'Invalid arguments for kilo_browser_resize: missing required argument "width"; missing required argument "height".',
      ok: false,
    });
    expect(session.commands).toStrictEqual([]);
  });

  it('rejects unknown arguments the contract schema does not allow', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({
        arguments: { bogus: true, target: 'e1' },
        session,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_click: unknown argument "bogus".',
      ok: false,
    });
    expect(session.commands).toStrictEqual([]);
    expect(session.resolveTarget).not.toHaveBeenCalled();
  });

  it('rejects a prototype property name the contract schema does not declare', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({
        arguments: { target: 'e1', toString: 'x' },
        session,
        toolName: 'kilo_browser_click',
      })
    ).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_click: unknown argument "toString".',
      ok: false,
    });
    expect(session.resolveTarget).not.toHaveBeenCalled();
  });

  it('rejects arguments that are not an object', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({
        arguments: ['not', 'an', 'object'],
        session,
        toolName: 'kilo_browser_snapshot',
      })
    ).resolves.toStrictEqual({
      error: 'Invalid arguments for kilo_browser_snapshot: arguments must be an object.',
      ok: false,
    });
  });

  it('treats absent arguments as empty', async () => {
    const session = createFakeSession();

    // The snapshot tool has no required fields, so absent arguments pass validation.
    await runKiloBrowserTool({ arguments: undefined, session, toolName: 'kilo_browser_snapshot' });

    expect(session.commands.length).toBeGreaterThan(0);
  });
});

describe('runKiloBrowserTool error paths', () => {
  it('reports an unknown tool by name', async () => {
    const session = createFakeSession();

    await expect(
      runKiloBrowserTool({ arguments: {}, session, toolName: 'kilo_browser_not_a_tool' })
    ).resolves.toStrictEqual({
      error: 'Unknown browser tool: kilo_browser_not_a_tool.',
      ok: false,
    });
    expect(session.commands).toStrictEqual([]);
  });

  it('turns a thrown handler error into a tool error', async () => {
    const session = createFakeSession();
    const handlerSpy = vi
      .spyOn(BROWSER_TOOL_HANDLERS, 'browser_resize')
      .mockRejectedValue(new Error('boom'));

    try {
      await expect(
        runKiloBrowserTool({
          arguments: { height: 1, width: 1 },
          session,
          toolName: 'kilo_browser_resize',
        })
      ).resolves.toStrictEqual({ error: 'boom', ok: false });
    } finally {
      handlerSpy.mockRestore();
    }
  });

  it('returns the session platform gate before running a tool the backend cannot express', async () => {
    const session = createFakeSession(
      'kilo_browser_console_messages is not available in Firefox: this browser exposes no debugger protocol.'
    );

    await expect(
      runKiloBrowserTool({
        arguments: { level: 'info' },
        session,
        toolName: 'kilo_browser_console_messages',
      })
    ).resolves.toStrictEqual({
      error:
        'kilo_browser_console_messages is not available in Firefox: this browser exposes no debugger protocol.',
      ok: false,
    });
    expect(session.commands).toStrictEqual([]);
  });
});
