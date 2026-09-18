/* eslint-disable id-length, jest/no-conditional-in-test, max-lines, require-await, typescript-eslint/no-base-to-string, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/require-await, unicorn/no-useless-undefined -- Fake CDP session returns verbatim responses for assertions. */
import { describe, expect, it } from 'vitest';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import {
  READ_BROWSER_TOOL_NAMES,
  isReadBrowserToolName,
  runReadBrowserTool,
} from './browser-tool-read-actions';
import type { BrowserAriaNode, BrowserToolPageSession } from './browser-tool-snapshot';
import type { BrowserConsoleMessage, BrowserNetworkRequest } from './browser-tool-session';

interface RecordedCommand {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

const axNode = (node: {
  backendDOMNodeId?: number;
  childIds?: string[];
  name?: string;
  nodeId: string;
  role?: string;
}): BrowserAriaNode => ({
  nodeId: node.nodeId,
  ...(node.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: node.backendDOMNodeId }),
  ...(node.childIds === undefined ? {} : { childIds: node.childIds }),
  ...(node.name === undefined ? {} : { name: { value: node.name } }),
  ...(node.role === undefined ? {} : { role: { value: node.role } }),
});

const SAMPLE_TREE: BrowserAriaNode[] = [
  axNode({ childIds: ['2', '3'], nodeId: '1', role: 'generic' }),
  axNode({ backendDOMNodeId: 11, name: 'Welcome', nodeId: '2', role: 'heading' }),
  axNode({ backendDOMNodeId: 12, name: 'Submit', nodeId: '3', role: 'button' }),
];

const createSession = ({
  attachError,
  axNodes = SAMPLE_TREE,
  boxes = {},
  consoleMessages = [],
  requestsSinceLoad = [],
  pageText = () => '',
  responseBody,
  screenshot = 'QUJD',
  timeOrigin,
  webMcpTools,
}: {
  attachError?: Error;
  axNodes?: BrowserAriaNode[];
  boxes?: Record<number, { content: number[]; height: number; width: number }>;
  consoleMessages?: BrowserConsoleMessage[];
  requestsSinceLoad?: BrowserNetworkRequest[];
  pageText?: () => string;
  responseBody?: { base64Encoded?: boolean; body?: string };
  screenshot?: string;
  timeOrigin?: number;
  webMcpTools?: { description?: string; name?: string; title?: string }[];
} = {}): { commands: RecordedCommand[]; session: BrowserToolPageSession } => {
  const commands: RecordedCommand[] = [];

  const session: BrowserToolPageSession = {
    attach: async () => {
      if (attachError !== undefined) {
        throw attachError;
      }
    },
    consoleMessages: () => consoleMessages,
    networkRequestsSinceLoad: () => requestsSinceLoad,
    registerRefs: () => undefined,
    resolveTarget: async (target: string) => {
      if (target === 'e12') {
        return { backendNodeId: 12, kind: 'ref', ref: 'e12' };
      }

      return target === '#go' ? { kind: 'selector', nodeId: 42, selector: '#go' } : undefined;
    },
    send: async (method, params) => {
      commands.push({ method, params });

      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: axNodes };
      }

      if (method === 'DOM.getBoxModel') {
        const backendNodeId = params?.['backendNodeId'];

        return typeof backendNodeId === 'number' && boxes[backendNodeId] !== undefined
          ? { model: boxes[backendNodeId] }
          : { model: { content: [1, 2, 3, 2, 3, 4, 1, 4], height: 2, width: 2 } };
      }

      if (method === 'Page.captureScreenshot') {
        return { data: screenshot };
      }

      if (method === 'Network.getResponseBody') {
        return responseBody ?? {};
      }

      if (method === 'Runtime.evaluate') {
        const expression = String(params?.['expression'] ?? '');

        if (expression.includes('performance.timeOrigin')) {
          return { result: { value: timeOrigin } };
        }

        if (expression.includes('modelContext')) {
          return { result: { value: JSON.stringify({ tools: webMcpTools ?? [] }) } };
        }

        return { result: { value: pageText() } };
      }

      return {};
    },
  };

  return { commands, session };
};

const consoleMessage = (
  level: string,
  text: string,
  timestamp?: number
): BrowserConsoleMessage => ({
  level,
  text,
  ...(timestamp === undefined ? {} : { timestamp }),
});

const networkRequest = (
  requestId: string,
  overrides: Partial<BrowserNetworkRequest> = {}
): BrowserNetworkRequest => ({
  requestId,
  url: `https://example.com/${requestId}`,
  ...overrides,
});

describe('read browser tool names', () => {
  it('covers the whole read-only surface and accepts the kilo_ prefix', () => {
    expect(READ_BROWSER_TOOL_NAMES).toHaveLength(8);
    expect(isReadBrowserToolName('browser_snapshot')).toBe(true);
    expect(isReadBrowserToolName('browser_click')).toBe(false);
    expect(READ_BROWSER_TOOL_NAMES).toContain('browser_webmcp_list');
  });

  it('rejects an unknown tool without throwing', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_click', {}, session);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining('Unknown read-only browser tool'),
    });
  });
});

describe('browser_snapshot', () => {
  it('returns the snapshot inline and notes an unusable filename', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool(
      'kilo_browser_snapshot',
      { filename: 'page.yaml' },
      session
    );

    expect(result.ok).toBe(true);
    const text = result.ok ? String(result.value) : '';
    expect(text).toContain('- button "Submit" [ref=e12]');
    expect(text).toContain('could not be written');
    expect(text.length).toBeGreaterThan(0);
  });

  it('reports an uninspectable tab as a tool error', async () => {
    const { session } = createSession({ attachError: new Error(TAB_NOT_INSPECTABLE_ERROR) });
    const result = await runReadBrowserTool('browser_snapshot', {}, session);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('cannot be inspected') });
  });

  it('translates the debugger\u2019s own chrome:// refusal', async () => {
    const { session } = createSession({ attachError: new Error('Cannot access a chrome:// URL') });
    const result = await runReadBrowserTool('browser_snapshot', {}, session);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('cannot be inspected') });
  });
});

describe('browser_find', () => {
  it('finds text case-insensitively under the node path', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_find', { text: 'submit' }, session);

    expect(result.ok).toBe(true);
    const text = result.ok ? String(result.value) : '';
    expect(text).toContain('Found 1 match(es) for "submit"');
    expect(text).toContain("Path: button 'Submit'");
    expect(text).toContain('- button "Submit" [ref=e12]');
  });

  it('finds by regex', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_find', { regex: '/wel+come/i' }, session);

    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.value : '')).toContain('heading "Welcome"');
  });

  it('keeps every match for a global-flag regex', async () => {
    const { session } = createSession({
      axNodes: [
        axNode({ childIds: ['2', '3'], nodeId: '1', role: 'generic' }),
        axNode({ backendDOMNodeId: 11, name: 'First', nodeId: '2', role: 'button' }),
        axNode({ backendDOMNodeId: 12, name: 'Second', nodeId: '3', role: 'button' }),
      ],
    });
    const result = await runReadBrowserTool('browser_find', { regex: '/button/gu' }, session);

    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.value : '')).toContain('Found 2 match(es)');
  });

  it('returns a successful no-match result', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_find', { text: 'nothing-here' }, session);

    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.value : '')).toContain('No matches for "nothing-here"');
  });

  it('rejects both or neither query', async () => {
    const { session } = createSession();

    await expect(runReadBrowserTool('browser_find', {}, session)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      runReadBrowserTool('browser_find', { regex: 'a', text: 'a' }, session)
    ).resolves.toMatchObject({ ok: false });
  });
});

describe('browser_take_screenshot', () => {
  it('returns the image and a text line', async () => {
    const { commands, session } = createSession();
    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'png' }, session);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      value: { dataUrl: 'data:image/png;base64,QUJD', mediaType: 'image/png' },
    });
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
    });
  });

  it('captures beyond the viewport for fullPage', async () => {
    const { commands, session } = createSession();
    await runReadBrowserTool('browser_take_screenshot', { fullPage: true }, session);

    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { captureBeyondViewport: true, format: 'png' },
    });
  });

  it('clips to an element target', async () => {
    const { commands, session } = createSession({
      boxes: { 12: { content: [3, 4, 13, 4, 13, 14, 3, 14], height: 10, width: 10 } },
    });
    const result = await runReadBrowserTool('browser_take_screenshot', { target: 'e12' }, session);

    expect(result.ok).toBe(true);
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { clip: { height: 10, scale: 1, width: 10, x: 3, y: 4 }, format: 'png' },
    });
  });

  it('rejects fullPage combined with a target', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { fullPage: true, target: 'e12' },
      session
    );

    expect(result.ok).toBe(false);
  });

  it('notes an unusable filename', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { filename: 'shot.png' },
      session
    );

    expect(result).toMatchObject({
      value: { text: expect.stringContaining('could not be written') },
    });
  });
});

describe('browser_wait_for', () => {
  it('waits the requested time', async () => {
    let nowMs = 0;
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_wait_for', { time: 2 }, session, {
      now: () => nowMs,
      sleep: async milliseconds => {
        nowMs += milliseconds;
      },
    });

    expect(result).toMatchObject({ ok: true, value: 'Waited 2.0 seconds.' });
  });

  it('returns when the text appears', async () => {
    let nowMs = 0;
    let text = '';
    const { session } = createSession({ pageText: () => text });
    const result = await runReadBrowserTool('browser_wait_for', { text: 'Ready' }, session, {
      now: () => nowMs,
      pollIntervalMs: 100,
      sleep: async milliseconds => {
        nowMs += milliseconds;
        text = 'Ready';
      },
      waitTimeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.value : '')).toContain('Text "Ready" appeared');
  });

  it('matches text case-insensitively and across whitespace, like the scripting backend', async () => {
    let nowMs = 0;
    const { session } = createSession({ pageText: () => 'READY   to\nstart' });
    const result = await runReadBrowserTool(
      'browser_wait_for',
      { text: 'ready to start' },
      session,
      {
        now: () => nowMs,
        pollIntervalMs: 100,
        sleep: async milliseconds => {
          nowMs += milliseconds;
        },
        waitTimeoutMs: 5000,
      }
    );

    expect(result.ok).toBe(true);
    expect(String(result.ok ? result.value : '')).toContain('Text "ready to start" appeared');
  });

  it('matches textGone case-insensitively too', async () => {
    let nowMs = 0;
    const { session } = createSession({ pageText: () => 'Loading' });
    const result = await runReadBrowserTool('browser_wait_for', { textGone: 'LOADING' }, session, {
      now: () => nowMs,
      pollIntervalMs: 100,
      sleep: async milliseconds => {
        nowMs += milliseconds;
      },
      waitTimeoutMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: 'Timed out waiting for text "LOADING" to disappear after 1.0 seconds.',
    });
  });

  it('names the text and the elapsed seconds on a timeout', async () => {
    let nowMs = 0;
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_wait_for', { text: 'Never' }, session, {
      now: () => nowMs,
      pollIntervalMs: 100,
      sleep: async milliseconds => {
        nowMs += milliseconds;
      },
      waitTimeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: 'Timed out waiting for text "Never" after 5.0 seconds.',
    });
  });

  it('reports a timed-out disappearance too', async () => {
    let nowMs = 0;
    const { session } = createSession({ pageText: () => 'Still here' });
    const result = await runReadBrowserTool(
      'browser_wait_for',
      { textGone: 'Still here' },
      session,
      {
        now: () => nowMs,
        pollIntervalMs: 100,
        sleep: async milliseconds => {
          nowMs += milliseconds;
        },
        waitTimeoutMs: 1000,
      }
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: 'Timed out waiting for text "Still here" to disappear after 1.0 seconds.',
    });
  });
});

describe('browser_console_messages', () => {
  it('each level includes the more severe ones', async () => {
    const { session } = createSession({
      consoleMessages: [
        consoleMessage('debug', 'debug line'),
        consoleMessage('info', 'info line'),
        consoleMessage('warning', 'warning line'),
        consoleMessage('error', 'error line'),
      ],
      timeOrigin: 0,
    });

    const info = await runReadBrowserTool('browser_console_messages', {}, session);
    const error = await runReadBrowserTool('browser_console_messages', { level: 'error' }, session);

    expect(String(info.ok ? info.value : '')).toContain('info line');
    expect(String(info.ok ? info.value : '')).toContain('error line');
    expect(String(info.ok ? info.value : '')).not.toContain('debug line');
    expect(String(error.ok ? error.value : '')).toContain('error line');
    expect(String(error.ok ? error.value : '')).not.toContain('warning line');
  });

  it('shows CDP log messages at the default info level and keeps verbose at debug', async () => {
    const { session } = createSession({
      consoleMessages: [
        consoleMessage('log', 'console.log line'),
        consoleMessage('verbose', 'verbose line'),
      ],
      timeOrigin: 0,
    });

    const info = await runReadBrowserTool('browser_console_messages', {}, session);
    const text = String(info.ok ? info.value : '');

    expect(text).toContain('console.log line');
    expect(text).not.toContain('verbose line');
  });

  it('drops messages from before the current navigation unless all is true', async () => {
    const { session } = createSession({
      consoleMessages: [
        consoleMessage('info', 'before nav', 100),
        consoleMessage('info', 'after nav', 200),
      ],
      timeOrigin: 150,
    });

    const since = await runReadBrowserTool('browser_console_messages', {}, session);
    const all = await runReadBrowserTool('browser_console_messages', { all: true }, session);

    expect(String(since.ok ? since.value : '')).not.toContain('before nav');
    expect(String(since.ok ? since.value : '')).toContain('after nav');
    expect(String(all.ok ? all.value : '')).toContain('before nav');
  });

  it('returns the empty sentinel', async () => {
    const { session } = createSession({ timeOrigin: 0 });
    const result = await runReadBrowserTool('browser_console_messages', {}, session);

    expect(result).toMatchObject({ ok: true, value: 'No console messages.' });
  });
});

describe('browser_network_requests', () => {
  it('lists requests since load and hides successful static resources by default', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('doc', { resourceType: 'Document', url: 'https://example.com/' }),
        networkRequest('css', {
          resourceType: 'Stylesheet',
          status: 200,
          url: 'https://example.com/a.css',
        }),
        networkRequest('api', {
          method: 'POST',
          resourceType: 'XHR',
          status: 200,
          url: 'https://example.com/api',
        }),
      ],
    });

    const result = await runReadBrowserTool('browser_network_requests', {}, session);
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('1. GET https://example.com/');
    expect(text).toContain('3. POST https://example.com/api [XHR] 200');
    expect(text).not.toContain('a.css');
  });

  it('numbers every request by its position in the full list, so browser_network_request can index a static request', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('doc', { resourceType: 'Document', url: 'https://example.com/' }),
        networkRequest('css', {
          resourceType: 'Stylesheet',
          status: 200,
          url: 'https://example.com/a.css',
        }),
        networkRequest('api', {
          resourceType: 'XHR',
          status: 200,
          url: 'https://example.com/api',
        }),
      ],
    });

    const listed = await runReadBrowserTool('browser_network_requests', { static: true }, session);
    const text = String(listed.ok ? listed.value : '');

    expect(text).toContain('1. GET https://example.com/');
    expect(text).toContain('2. GET https://example.com/a.css');
    expect(text).toContain('3. GET https://example.com/api');

    const detail = await runReadBrowserTool('browser_network_request', { index: 2 }, session);

    expect(String(detail.ok ? detail.value : '')).toContain(
      'Request #2: GET https://example.com/a.css'
    );
  });

  it('includes static resources when asked and filters by regex', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('css', {
          resourceType: 'Stylesheet',
          status: 200,
          url: 'https://example.com/a.css',
        }),
        networkRequest('api', { resourceType: 'XHR', status: 200, url: 'https://example.com/api' }),
      ],
    });

    const result = await runReadBrowserTool(
      'browser_network_requests',
      { filter: 'a\\.css$', static: true },
      session
    );
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('a.css');
    expect(text).not.toContain('/api');
  });

  it('returns the empty sentinel', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_network_requests', {}, session);

    expect(result).toMatchObject({ ok: true, value: 'No network requests.' });
  });

  it('keeps the main document in the list when a subframe document follows', async () => {
    // The session's since-load boundary is the last main-frame document; a subframe's document request must not hide it or shift numbering.
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('doc', {
          frameId: 'main',
          resourceType: 'Document',
          url: 'https://example.com/',
        }),
        networkRequest('frame-doc', {
          frameId: 'frame-1',
          resourceType: 'Document',
          url: 'https://example.com/embed',
        }),
      ],
    });

    const result = await runReadBrowserTool('browser_network_requests', {}, session);
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('1. GET https://example.com/');
    expect(text).toContain('2. GET https://example.com/embed');
  });
});

describe('browser_network_request', () => {
  it('returns one request with headers and body', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('api', {
          method: 'POST',
          postData: '{"a":1}',
          requestHeaders: { 'x-test': '1' },
          resourceType: 'XHR',
          responseHeaders: { 'content-type': 'application/json' },
          status: 200,
          statusText: 'OK',
          url: 'https://example.com/api',
        }),
      ],
    });

    const result = await runReadBrowserTool('browser_network_request', { index: 1 }, session);
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('Request #1: POST https://example.com/api');
    expect(text).toContain('  x-test: 1');
    expect(text).toContain('Request body: {"a":1}');
  });

  it('honours part and fetches the response body', async () => {
    const { session } = createSession({
      requestsSinceLoad: [networkRequest('api', { resourceType: 'XHR', status: 200 })],
      responseBody: { body: '{"ok":true}' },
    });

    const headers = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'request-headers' },
      session
    );
    const body = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );

    expect(String(headers.ok ? headers.value : '')).toContain('request-headers for request #1:');
    expect(String(body.ok ? body.value : '')).toContain('{"ok":true}');
  });

  it('errors on an out-of-range number', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_network_request', { index: 9 }, session);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('No request #9') });
  });
});

describe('browser_webmcp_list', () => {
  it('lists the tools the page registered', async () => {
    const { session } = createSession({
      webMcpTools: [{ description: 'Does a thing', name: 'do_thing', title: 'Do thing' }],
    });

    const result = await runReadBrowserTool('browser_webmcp_list', {}, session);

    expect(String(result.ok ? result.value : '')).toContain('1. do_thing — Do thing: Does a thing');
  });

  it('returns the empty sentinel', async () => {
    const { session } = createSession();
    const result = await runReadBrowserTool('browser_webmcp_list', {}, session);

    expect(result).toMatchObject({ ok: true, value: 'No WebMCP tools.' });
  });
});
