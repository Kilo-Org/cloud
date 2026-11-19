/* eslint-disable id-length, jest/no-conditional-in-test, jest/max-expects, max-lines, require-await, sort-keys, typescript-eslint/no-base-to-string, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/require-await, unicorn/no-useless-undefined -- Fake CDP session returns verbatim responses for assertions; masked-output tests assert many unrelated fields at once. */
import { describe, expect, it } from 'vitest';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import {
  READ_BROWSER_TOOL_NAMES,
  isReadBrowserToolName,
  runReadBrowserTool,
} from './browser-tool-read-actions';
import type { BrowserAriaNode, BrowserToolPageSession } from './browser-tool-snapshot';
import type { BrowserConsoleMessage, BrowserNetworkRequest } from './browser-tool-session';
import type { ScreenshotMaskInput, ScreenshotMaskResult } from './browser-screenshot-masking';

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
  axNodesByFrame,
  boxes = {},
  consoleMessages = [],
  frameOwnerBackendNodeId = 99,
  frameTree,
  freshFrame,
  layoutMetrics,
  layoutMetricsError = false,
  requestsSinceLoad = [],
  pageText = () => '',
  responseBody,
  screenshot = 'QUJD',
  timeOrigin,
  webMcpTools,
}: {
  attachError?: Error;
  axNodes?: BrowserAriaNode[];
  axNodesByFrame?: Record<string, BrowserAriaNode[]>;
  boxes?: Record<number, { content: number[]; height: number; width: number }>;
  consoleMessages?: BrowserConsoleMessage[];
  frameOwnerBackendNodeId?: number;
  frameTree?: Record<string, unknown>;
  /** The frame the tab's screencast would hand back; absent means the session could not force one. */
  freshFrame?: string;
  layoutMetrics?: Record<string, unknown>;
  layoutMetricsError?: boolean;
  requestsSinceLoad?: BrowserNetworkRequest[];
  pageText?: () => string;
  responseBody?: { base64Encoded?: boolean; body?: string };
  screenshot?: string;
  timeOrigin?: number;
  webMcpTools?: { description?: string; name?: string; title?: string }[];
} = {}): {
  commands: RecordedCommand[];
  freshRequests: string[];
  /** The pixel size each forced frame asked the screencast for: undefined means the tab's own device pixels. */
  freshSizes: ({ readonly height: number; readonly width: number } | undefined)[];
  session: BrowserToolPageSession;
} => {
  const commands: RecordedCommand[] = [];
  const freshRequests: string[] = [];
  const freshSizes: ({ readonly height: number; readonly width: number } | undefined)[] = [];

  const session: BrowserToolPageSession = {
    attach: async () => {
      if (attachError !== undefined) {
        throw attachError;
      }
    },
    captureViewportImage: async (format, options) => {
      freshRequests.push(format);
      freshSizes.push(options?.size);

      return freshFrame;
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
        const frameId = params?.['frameId'];

        return {
          nodes: (typeof frameId === 'string' ? axNodesByFrame?.[frameId] : undefined) ?? axNodes,
        };
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

      if (method === 'Page.getFrameTree') {
        return frameTree ?? {};
      }

      if (method === 'Page.getLayoutMetrics') {
        if (layoutMetricsError) {
          throw new Error('layout metrics unavailable');
        }

        return layoutMetrics ?? {};
      }

      if (method === 'DOM.getFrameOwner') {
        return { backendNodeId: frameOwnerBackendNodeId };
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

  return { commands, freshRequests, freshSizes, session };
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

  it('reads a granted iframe through its own document when the call targets its ref', async () => {
    const { session } = createSession({
      axNodesByFrame: {
        child: [
          axNode({ childIds: ['2'], nodeId: '1', role: 'RootWebArea' }),
          axNode({
            backendDOMNodeId: 21,
            name: 'card marker-42',
            nodeId: '2',
            role: 'StaticText',
          }),
        ],
      },
      frameOwnerBackendNodeId: 12,
      frameTree: {
        frameTree: {
          childFrames: [
            {
              frame: {
                id: 'child',
                parentId: 'main',
                securityOrigin: 'https://pay.example.com',
                url: 'https://pay.example.com/widget',
              },
            },
          ],
          frame: {
            id: 'main',
            securityOrigin: 'https://app.example.com',
            url: 'https://app.example.com/dashboard',
          },
        },
      },
    });

    const result = await runReadBrowserTool('browser_snapshot', { target: 'e12' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com', 'https://pay.example.com'] },
    });

    expect(result.ok).toBe(true);
    const text = result.ok ? String(result.value) : '';

    expect(text).toContain('card marker-42');
    expect(text).not.toContain('Submit');
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
  const FRAME_TREE_WITH_PAY = {
    frameTree: {
      childFrames: [
        {
          frame: {
            id: 'f1',
            parentId: 'main',
            securityOrigin: 'https://pay.example.com',
            url: 'https://pay.example.com/widget',
          },
        },
      ],
      frame: {
        id: 'main',
        securityOrigin: 'https://app.example.com',
        url: 'https://app.example.com/dashboard',
      },
    },
  };

  const recordMask = (): {
    readonly inputs: ScreenshotMaskInput[];
    readonly mask: (input: ScreenshotMaskInput) => Promise<ScreenshotMaskResult>;
  } => {
    const inputs: ScreenshotMaskInput[] = [];

    return {
      inputs,
      mask: input => {
        inputs.push(input);

        return Promise.resolve({ dataUrl: 'data:image/png;base64,TUFTS0VE', ok: true });
      },
    };
  };

  it('takes the frame the tab can force instead of waiting for the next presented one', async () => {
    const { commands, freshRequests, session } = createSession({ freshFrame: 'RlJFU0g=' });

    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'png' }, session);

    expect(result.ok).toBe(true);
    expect(freshRequests).toStrictEqual(['png']);
    // The forced frame is the image: no plain capture went out.
    expect(commands.some(command => command.method === 'Page.captureScreenshot')).toBe(false);
    expect(result.ok ? result.value : undefined).toMatchObject({
      dataUrl: 'data:image/png;base64,RlJFU0g=',
      mediaType: 'image/png',
    });
  });

  it('falls back to a plain capture when the tab cannot force a frame', async () => {
    const { commands, session } = createSession({ screenshot: 'UExBSU4=' });

    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'png' }, session);

    expect(result.ok ? result.value : undefined).toMatchObject({
      dataUrl: 'data:image/png;base64,UExBSU4=',
    });
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { format: 'png', fromSurface: true },
    });
  });

  it('never takes a forced frame for a full-page or an element capture', async () => {
    const { freshRequests, session } = createSession({ freshFrame: 'RlJFU0g=' });

    await runReadBrowserTool('browser_take_screenshot', { fullPage: true, type: 'png' }, session);
    await runReadBrowserTool('browser_take_screenshot', { target: 'e12' }, session);

    expect(freshRequests).toStrictEqual([]);
  });

  it('keeps a webp request off the forced frame, which has no webp format', async () => {
    const { commands, freshRequests, session } = createSession({
      freshFrame: 'RlJFU0g=',
      screenshot: 'V0VCUA==',
    });

    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'webp' }, session);

    // `Page.startScreencast` would answer with png or jpeg bytes; the plain capture is the one that honours webp.
    expect(freshRequests).toStrictEqual([]);
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { format: 'webp', fromSurface: true },
    });
    expect(result.ok ? result.value : undefined).toMatchObject({
      dataUrl: 'data:image/webp;base64,V0VCUA==',
      mediaType: 'image/webp',
    });
  });

  it('masks the forced frame with the viewport geometry, in the image the mask is applied to', async () => {
    const { session } = createSession({
      frameTree: FRAME_TREE_WITH_PAY,
      freshFrame: 'RlJFU0g=',
      // A masked css capture needs a proven scale: the CSS viewport is what makes the image CSS-sized.
      layoutMetrics: {
        cssLayoutViewport: { clientHeight: 400, clientWidth: 800 },
        cssVisualViewport: { pageX: 0, pageY: 0 },
        layoutViewport: { clientHeight: 400, clientWidth: 800 },
      },
    });
    const { inputs, mask } = recordMask();

    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'png' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    expect(result.ok).toBe(true);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.dataUrl).toBe('data:image/png;base64,RlJFU0g=');
  });

  it('masks a withheld frame inside an element capture in the clip coordinate space', async () => {
    // The clip is the iframe's own rect, so its page-space box lands at the image origin.
    const iframeRect = { content: [40, 120, 440, 120, 440, 320, 40, 320], height: 200, width: 400 };
    const { session } = createSession({
      boxes: { 12: iframeRect, 99: iframeRect },
      frameTree: FRAME_TREE_WITH_PAY,
    });
    const { inputs, mask } = recordMask();

    const result = await runReadBrowserTool('browser_take_screenshot', { target: 'e12' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    expect(result.ok).toBe(true);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.boxes).toStrictEqual([{ height: 200, left: 0, top: 0, width: 400 }]);
    expect(inputs[0]?.scale).toBe(1);
  });

  it('renders a device-scale element capture at the device pixel ratio', async () => {
    const iframeRect = { content: [40, 120, 440, 120, 440, 320, 40, 320], height: 200, width: 400 };
    const { commands, session } = createSession({
      boxes: { 12: iframeRect, 99: iframeRect },
      frameTree: FRAME_TREE_WITH_PAY,
      layoutMetrics: {
        cssLayoutViewport: { clientWidth: 400 },
        layoutViewport: { clientWidth: 800 },
      },
    });
    const { inputs, mask } = recordMask();

    await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'device', target: 'e12' },
      session,
      {
        agentScope: { readableOrigins: ['https://app.example.com'] },
        maskScreenshot: mask,
      }
    );

    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: {
        clip: { height: 200, scale: 2, width: 400, x: 40, y: 120 },
        format: 'png',
        fromSurface: true,
      },
    });
    expect(inputs[0]?.scale).toBe(2);
  });

  it('renders a device-scale element capture for a panel caller too', async () => {
    const { commands, session } = createSession({
      boxes: { 12: { content: [10, 20, 110, 20, 110, 70, 10, 70], height: 50, width: 100 } },
      layoutMetrics: {
        cssLayoutViewport: { clientWidth: 400 },
        layoutViewport: { clientWidth: 800 },
      },
    });

    // The side panel and a workflow run have no agent scope, and still asked for device pixels.
    await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'device', target: 'e12' },
      session
    );

    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: {
        clip: { height: 50, scale: 2, width: 100, x: 10, y: 20 },
        format: 'png',
        fromSurface: true,
      },
    });
  });

  it('reports the masked image as PNG whatever the capture type was', async () => {
    const iframeRect = { content: [40, 120, 440, 120, 440, 320, 40, 320], height: 200, width: 400 };
    const { session } = createSession({
      boxes: { 12: iframeRect, 99: iframeRect },
      frameTree: FRAME_TREE_WITH_PAY,
    });
    const { mask } = recordMask();

    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'css', target: 'e12', type: 'jpeg' },
      session,
      { agentScope: { readableOrigins: ['https://app.example.com'] }, maskScreenshot: mask }
    );

    expect(result).toMatchObject({
      ok: true,
      value: { dataUrl: 'data:image/png;base64,TUFTS0VE', mediaType: 'image/png' },
    });
  });

  it('keeps the capture media type when nothing is masked', async () => {
    const { session } = createSession({ frameTree: FRAME_TREE_WITH_PAY });

    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'css', type: 'jpeg' },
      session,
      {
        agentScope: { readableOrigins: ['https://app.example.com', 'https://pay.example.com'] },
        maskScreenshot: () =>
          Promise.resolve({ dataUrl: 'data:image/png;base64,TUFTS0VE', ok: true }),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      value: { dataUrl: 'data:image/jpeg;base64,QUJD', mediaType: 'image/jpeg' },
    });
  });

  it('captures and masks a scrolled element in document space', async () => {
    // The box model reports viewport coordinates; the clip the capture takes is document-space.
    const viewportRect = {
      content: [40, 120, 440, 120, 440, 320, 40, 320],
      height: 200,
      width: 400,
    };
    const { commands, session } = createSession({
      boxes: { 12: viewportRect, 99: viewportRect },
      frameTree: FRAME_TREE_WITH_PAY,
      layoutMetrics: {
        cssLayoutViewport: { clientWidth: 400 },
        cssVisualViewport: { pageX: 100, pageY: 50 },
        layoutViewport: { clientWidth: 400 },
      },
    });
    const { inputs, mask } = recordMask();

    await runReadBrowserTool('browser_take_screenshot', { scale: 'css', target: 'e12' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: {
        clip: { height: 200, scale: 1, width: 400, x: 140, y: 170 },
        format: 'png',
        fromSurface: true,
      },
    });
    expect(inputs[0]?.boxes).toStrictEqual([{ height: 200, left: 0, top: 0, width: 400 }]);
  });

  it('masks a scrolled viewport capture where the frame paints in the image', async () => {
    const viewportRect = {
      content: [40, 120, 440, 120, 440, 320, 40, 320],
      height: 200,
      width: 400,
    };
    const { session } = createSession({
      boxes: { 99: viewportRect },
      frameTree: FRAME_TREE_WITH_PAY,
      layoutMetrics: {
        cssLayoutViewport: { clientHeight: 200, clientWidth: 400 },
        cssVisualViewport: { pageX: 100, pageY: 50 },
        layoutViewport: { clientHeight: 200, clientWidth: 400 },
      },
    });
    const { inputs, mask } = recordMask();

    await runReadBrowserTool('browser_take_screenshot', { scale: 'css' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    // The withheld frame sits at viewport (40,120); the viewport image starts at the scroll position.
    expect(inputs[0]?.boxes).toStrictEqual([{ height: 200, left: 40, top: 120, width: 400 }]);
  });

  it('takes a css-scale viewport capture at the CSS size on a 2x tab, and masks at that scale', async () => {
    const { freshSizes, session } = createSession({
      frameTree: FRAME_TREE_WITH_PAY,
      freshFrame: 'RlJFU0g=',
      layoutMetrics: {
        cssLayoutViewport: { clientHeight: 400, clientWidth: 800 },
        cssVisualViewport: { pageX: 0, pageY: 0 },
        layoutViewport: { clientHeight: 800, clientWidth: 1600 },
      },
    });
    const { inputs, mask } = recordMask();

    await runReadBrowserTool('browser_take_screenshot', { scale: 'css', type: 'png' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    // The image is the viewport in CSS pixels: the screencast is asked for that size, not the tab's 2x pixels.
    expect(freshSizes).toStrictEqual([{ height: 400, width: 800 }]);
    // The mask boxes are CSS pixels, so they map onto that image one for one.
    expect(inputs[0]?.scale).toBe(1);
  });

  it('refuses a masked css capture when the CSS viewport is unknown, instead of masking at a guess', async () => {
    const { session } = createSession({
      frameTree: FRAME_TREE_WITH_PAY,
      layoutMetrics: {
        // The layout viewport is in device pixels; without a CSS width there is neither a viewport nor a ratio.
        layoutViewport: { clientHeight: 800, clientWidth: 1600 },
      },
    });
    const { inputs, mask } = recordMask();

    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'css', type: 'png' },
      session,
      { agentScope: { readableOrigins: ['https://app.example.com'] }, maskScreenshot: mask }
    );

    // A 1x mask over a device-pixel image would leave a withheld frame's pixels visible: fail closed instead.
    expect(result.ok).toBe(false);
    expect(inputs).toStrictEqual([]);
    expect(result.ok ? '' : result.error).toContain('viewport could not be measured');
  });

  it('clips a device-scale viewport capture at the tab\u2019s ratio and masks at the same scale', async () => {
    const { commands, freshSizes, session } = createSession({
      frameTree: FRAME_TREE_WITH_PAY,
      layoutMetrics: {
        cssLayoutViewport: { clientHeight: 400, clientWidth: 800 },
        cssVisualViewport: { pageX: 0, pageY: 0 },
        layoutViewport: { clientHeight: 800, clientWidth: 1600 },
      },
    });
    const { inputs, mask } = recordMask();

    await runReadBrowserTool('browser_take_screenshot', { scale: 'device', type: 'png' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    // A device-pixel capture is the viewport rendered at the tab's own ratio: no css size is asked for, and the
    // Plain capture cuts exactly that region.
    expect(freshSizes).toStrictEqual([undefined]);
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: {
        clip: { height: 400, scale: 2, width: 800, x: 0, y: 0 },
        format: 'png',
        fromSurface: true,
      },
    });
    expect(inputs[0]?.scale).toBe(2);
  });

  it('drops a withheld frame that the element clip does not overlap', async () => {
    const { session } = createSession({
      boxes: {
        12: { content: [0, 0, 200, 0, 200, 100, 0, 100], height: 100, width: 200 },
        99: { content: [300, 400, 500, 400, 500, 500, 300, 500], height: 100, width: 200 },
      },
      frameTree: FRAME_TREE_WITH_PAY,
    });
    const { inputs, mask } = recordMask();

    const result = await runReadBrowserTool('browser_take_screenshot', { target: 'e12' }, session, {
      agentScope: { readableOrigins: ['https://app.example.com'] },
      maskScreenshot: mask,
    });

    expect(result.ok).toBe(true);
    expect(inputs).toHaveLength(0);
    expect(result).toMatchObject({ value: { dataUrl: 'data:image/png;base64,QUJD' } });
  });

  it('returns the image and a text line', async () => {
    const { commands, session } = createSession();
    const result = await runReadBrowserTool('browser_take_screenshot', { type: 'png' }, session);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      value: { dataUrl: 'data:image/png;base64,QUJD', mediaType: 'image/png' },
    });
    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { format: 'png', fromSurface: true },
    });
  });

  it('captures beyond the viewport for fullPage', async () => {
    const { commands, session } = createSession();
    await runReadBrowserTool('browser_take_screenshot', { fullPage: true }, session);

    expect(commands).toContainEqual({
      method: 'Page.captureScreenshot',
      params: { captureBeyondViewport: true, format: 'png', fromSurface: true },
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
      params: {
        clip: { height: 10, scale: 1, width: 10, x: 3, y: 4 },
        format: 'png',
        fromSurface: true,
      },
    });
  });

  it('keeps a panel element capture working when layout metrics fail', async () => {
    const { session } = createSession({ layoutMetricsError: true });

    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'css', target: 'e12', type: 'png' },
      session
    );

    expect(result.ok).toBe(true);
  });

  it('fails an agent element capture closed when layout metrics fail', async () => {
    const { session } = createSession({ layoutMetricsError: true });

    const result = await runReadBrowserTool(
      'browser_take_screenshot',
      { scale: 'css', target: 'e12', type: 'png' },
      session,
      { agentScope: { readableOrigins: ['https://app.example.com'] } }
    );

    expect(result.ok).toBe(false);
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
  it('returns one request with redacted headers and no request body by default', async () => {
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
    expect(text).toContain("(use part: 'request-body')");
    expect(text).not.toContain('{"a":1}');
  });

  it('replaces listed header values in the default view', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('authed', {
          method: 'POST',
          postData: 'user=ada&password=hunter2',
          requestHeaders: {
            authorization: 'Bearer fixture-auth-value',
            cookie: 'session=fixture-cookie-1',
            'content-type': 'application/x-www-form-urlencoded',
          },
          responseHeaders: { 'set-cookie': 'sid=response-fixture-cookie' },
          status: 200,
          url: 'https://example.com/login',
        }),
      ],
    });

    const result = await runReadBrowserTool('browser_network_request', { index: 1 }, session);
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('  authorization: [REDACTED]');
    expect(text).toContain('  cookie: [REDACTED]');
    expect(text).toContain('  set-cookie: [REDACTED]');
    expect(text).toContain('  content-type: application/x-www-form-urlencoded');
    expect(text).not.toContain('fixture-auth-value');
    expect(text).not.toContain('fixture-cookie-1');
    expect(text).not.toContain('hunter2');
  });

  it('replaces listed header values and request body fields for explicit parts', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('authed', {
          method: 'POST',
          postData: 'user=ada&password=hunter2',
          requestHeaders: { authorization: 'Bearer fixture-auth-value', 'x-test': '1' },
          resourceType: 'XHR',
          status: 200,
        }),
      ],
      responseBody: { body: '{"ok":true,"refreshToken":"rt-fixture-1"}' },
    });

    const headers = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'request-headers' },
      session
    );
    const requestBody = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'request-body' },
      session
    );
    const responseHeaders = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-headers' },
      session
    );
    const body = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );

    const headerText = String(headers.ok ? headers.value : '');

    expect(headerText).toContain('request-headers for request #1:');
    expect(headerText).toContain('  x-test: 1');
    expect(headerText).toContain('  authorization: [REDACTED]');
    expect(headerText).not.toContain('fixture-auth-value');

    const requestBodyText = String(requestBody.ok ? requestBody.value : '');

    expect(requestBodyText).toContain('user=ada');
    expect(requestBodyText).toContain('password=[REDACTED]');
    expect(requestBodyText).not.toContain('hunter2');

    expect(String(responseHeaders.ok ? responseHeaders.value : '')).toContain(
      'response-headers for request #1:'
    );
    const responseBodyText = String(body.ok ? body.value : '');

    expect(responseBodyText).toContain('"refreshToken": "[REDACTED]"');
    expect(responseBodyText).not.toContain('rt-fixture-1');
  });

  it('renders a base64 body with its marker', async () => {
    const { session } = createSession({
      requestsSinceLoad: [networkRequest('blob', { resourceType: 'XHR', status: 200 })],
      responseBody: { base64Encoded: true, body: 'eyJvayI6dHJ1ZX0=' },
    });

    const result = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );

    expect(String(result.ok ? result.value : '')).toContain('(base64) eyJvayI6dHJ1ZX0=');
  });

  it('replaces listed keys inside a base64 response body', async () => {
    const { session } = createSession({
      requestsSinceLoad: [networkRequest('blob', { resourceType: 'XHR', status: 200 })],
      responseBody: {
        base64Encoded: true,
        body: btoa('{"ok":true,"refreshToken":"rt-base64-1"}'),
      },
    });

    const result = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('(base64, decoded)');
    expect(text).toContain('"refreshToken": "[REDACTED]"');
    expect(text).not.toContain('rt-base64-1');
  });

  it('replaces listed keys in JSON request bodies returned for the explicit part', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('login', {
          method: 'POST',
          postData: '{"email":"ada@example.com","apiKey":"ak-fixture-1"}',
          resourceType: 'XHR',
          status: 200,
        }),
      ],
    });

    const requestBody = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'request-body' },
      session
    );
    const text = String(requestBody.ok ? requestBody.value : '');

    expect(text).toContain('"email": "ada@example.com"');
    expect(text).toContain('"apiKey": "[REDACTED]"');
    expect(text).not.toContain('ak-fixture-1');
  });

  it('hides private-key material in a response body under any field name', async () => {
    const { session } = createSession({
      requestsSinceLoad: [networkRequest('account', { resourceType: 'XHR', status: 200 })],
      responseBody: {
        body: JSON.stringify({
          account: 'svc@example.com',
          material: '-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody',
        }),
      },
    });

    const result = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('"account": "svc@example.com"');
    expect(text).toContain('"material": "[REDACTED]"');
    expect(text).not.toContain('MIIEfixtureBody');
  });

  it('hides a plain text response body that carries a pem block', async () => {
    const { session } = createSession({
      requestsSinceLoad: [networkRequest('download', { resourceType: 'Other', status: 200 })],
      responseBody: { body: '-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody' },
    });

    const result = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'response-body' },
      session
    );
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('MIIEfixtureBody');
  });

  it('hides a request body that carries a pem block', async () => {
    const { session } = createSession({
      requestsSinceLoad: [
        networkRequest('upload', {
          method: 'POST',
          postData: 'upload-name=material\n-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody',
          resourceType: 'XHR',
          status: 200,
        }),
      ],
    });

    const result = await runReadBrowserTool(
      'browser_network_request',
      { index: 1, part: 'request-body' },
      session
    );
    const text = String(result.ok ? result.value : '');

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('MIIEfixtureBody');
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
