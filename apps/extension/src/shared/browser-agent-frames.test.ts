/* eslint-disable max-lines, require-await -- the suite covers frame tree reading, scoped snapshots, masking, and filtering against one fake CDP session whose channel is async by contract. */
import { describe, expect, it } from 'vitest';
import {
  buildScopedSnapshot,
  captureAgentAriaSnapshot,
  captureAgentSnapshotView,
  filterAgentConsoleMessages,
  filterAgentNetworkRequests,
  readAgentFrameTree,
  readAgentScreenshotGeometry,
  readSensitiveFieldBoxes,
  readWithheldFrameBoxes,
  screenshotScale,
  withheldFramesOf,
  withheldFrameLine,
} from './browser-agent-frames';
import type { BrowserAgentFrame } from './browser-agent-frames';
import type { BrowserConsoleMessage, BrowserToolRefEntry } from './browser-tool-session';

type CdpHandler = (
  params: Record<string, unknown> | undefined
) => Record<string, unknown> | undefined;

// The screenshot clip names its translation `x` and `y`; the quotes keep those
// CDP names out of the identifier-length rule.
// prettier-ignore
const offsetOf = (horizontal: number, vertical: number) => ({
  'x': horizontal,
  'y': vertical,
});

// Backend node 10 is the iframe's owner; every other node reports the outer frame's box.
const frameBoxModel: CdpHandler = params =>
  params?.['backendNodeId'] === 10
    ? { model: { content: [40, 60, 240, 60, 240, 260, 40, 260], height: 200, width: 200 } }
    : { model: { content: [0, 0, 100, 0, 100, 100, 0, 100], height: 100, width: 100 } };

interface FakeSession {
  readonly refs: BrowserToolRefEntry[][];
  readonly send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>;
  readonly registerRefs: (entries: readonly BrowserToolRefEntry[]) => void;
}

const createFakeSession = (handlers: Record<string, CdpHandler>): FakeSession => {
  const refs: BrowserToolRefEntry[][] = [];

  return {
    refs,
    registerRefs: entries => {
      refs.push([...entries]);
    },
    send: async (method, params) => {
      const handler = handlers[method];

      if (handler === undefined) {
        throw new Error(`unexpected CDP method ${method}`);
      }

      return handler(params);
    },
  };
};

const FRAMES: readonly BrowserAgentFrame[] = [
  { id: 'main', origin: 'https://app.example.com', url: 'https://app.example.com/dashboard' },
  {
    id: 'f1',
    origin: 'https://pay.example.com',
    parentId: 'main',
    url: 'https://pay.example.com/widget',
  },
];

const frameTreePayload = (frames: readonly BrowserAgentFrame[]): Record<string, unknown> => {
  const childFrames = frames
    .filter(frame => frame.parentId !== undefined)
    .map(frame => ({
      frame: {
        id: frame.id,
        parentId: frame.parentId,
        securityOrigin: frame.origin,
        url: frame.url,
      },
    }));

  return {
    frameTree: {
      childFrames,
      frame: {
        id: 'main',
        securityOrigin: 'https://app.example.com',
        url: 'https://app.example.com/dashboard',
      },
    },
  };
};

const MAIN_TREE = {
  nodes: [
    { backendDOMNodeId: 1, childIds: ['2', '4'], nodeId: '1', role: { value: 'RootWebArea' } },
    { backendDOMNodeId: 2, name: { value: 'Submit' }, nodeId: '2', role: { value: 'button' } },
    { backendDOMNodeId: 10, childIds: ['5'], nodeId: '4', role: { value: 'Iframe' } },
    {
      backendDOMNodeId: 11,
      name: { value: 'leaked inner text' },
      nodeId: '5',
      role: { value: 'StaticText' },
    },
  ],
};

const CHILD_TREE = {
  nodes: [
    { childIds: ['2'], nodeId: '1', role: { value: 'RootWebArea' } },
    {
      backendDOMNodeId: 21,
      name: { value: 'card marker-42' },
      nodeId: '2',
      role: { value: 'StaticText' },
    },
  ],
};

const snapshotHandlers = (childTree: Record<string, unknown>): Record<string, CdpHandler> => ({
  'Accessibility.getFullAXTree': params =>
    (params ?? {})['frameId'] === 'main' ? MAIN_TREE : childTree,
  'Page.createIsolatedWorld': () => ({ executionContextId: 5 }),
  'Page.getFrameTree': () => frameTreePayload(FRAMES),
  'Runtime.evaluate': () => ({ result: { value: '{"hidden":[],"values":[]}' } }),
});

describe('frame tree reading', () => {
  it('flattens parent and child frames with their origins', async () => {
    const session = createFakeSession({ 'Page.getFrameTree': () => frameTreePayload(FRAMES) });

    await expect(readAgentFrameTree(session)).resolves.toStrictEqual(FRAMES);
  });
});

describe('withheld frame detection', () => {
  it('withholds a child frame whose origin lacks read and never the main frame', () => {
    expect(withheldFramesOf(FRAMES, ['https://app.example.com'])).toStrictEqual([
      { frameId: 'f1', origin: 'https://pay.example.com' },
    ]);
    expect(
      withheldFramesOf(FRAMES, ['https://app.example.com', 'https://pay.example.com'])
    ).toStrictEqual([]);
  });
});

describe('scoped snapshot', () => {
  it('replaces a withheld frame subtree with its origin line', async () => {
    const session = createFakeSession({
      ...snapshotHandlers(CHILD_TREE),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    const capture = await captureAgentAriaSnapshot(session, {
      readableOrigins: ['https://app.example.com'],
    });

    expect(capture.text).toContain('- iframe [origin withheld: https://pay.example.com]');
    expect(capture.text).toContain('- button "Submit" [ref=e2]');
    expect(capture.text).not.toContain('marker-42');
    expect(capture.text).not.toContain('leaked inner text');
    expect(capture.withheldFrames).toStrictEqual(['https://pay.example.com']);
  });

  it('splices a readable frame’s tree in at the iframe node', async () => {
    const session = createFakeSession({
      ...snapshotHandlers(CHILD_TREE),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    const capture = await captureAgentAriaSnapshot(session, {
      readableOrigins: ['https://app.example.com', 'https://pay.example.com'],
    });

    expect(capture.text).toContain('- text: card marker-42');
    expect(capture.text).not.toContain('origin withheld');
    expect(capture.withheldFrames).toStrictEqual([]);
  });

  it('drops hidden text and masks password values before the text leaves', async () => {
    const session = createFakeSession({
      ...snapshotHandlers({
        nodes: [
          { childIds: ['2', '3'], nodeId: '1', role: { value: 'RootWebArea' } },
          {
            backendDOMNodeId: 31,
            name: { value: 'hidden banner' },
            nodeId: '2',
            role: { value: 'StaticText' },
          },
          {
            backendDOMNodeId: 32,
            name: { value: 'hunter2' },
            nodeId: '3',
            role: { value: 'StaticText' },
          },
        ],
      }),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
      'Runtime.evaluate': () => ({
        result: { value: JSON.stringify({ hidden: ['hidden banner'], values: ['hunter2'] }) },
      }),
    });

    const view = await captureAgentSnapshotView(session, {
      readableOrigins: ['https://app.example.com', 'https://pay.example.com'],
    });

    expect(view.text).not.toContain('hidden banner');
    expect(view.text).not.toContain('hunter2');
    expect(view.text).toContain('- text: [masked]');
    expect(session.refs.at(-1)?.map(entry => entry.ref)).toStrictEqual(['e2']);
  });

  it('renders the withheld line at the iframe’s depth', () => {
    const snapshot = buildScopedSnapshot({
      ownerFrameByBackendNodeId: new Map([[10, 'f1']]),
      readableTrees: new Map(),
      topNodes: MAIN_TREE.nodes,
      withheld: new Map([['f1', 'https://pay.example.com']]),
    });

    expect(snapshot.lines).toStrictEqual([
      { depth: 1, name: 'Submit', ref: 'e2', role: 'button' },
      withheldFrameLine('https://pay.example.com', 2),
    ]);
  });
});

describe('screenshot geometry', () => {
  it('masks the withheld frame box and clips nested frames', async () => {
    const session = createFakeSession({
      'DOM.getBoxModel': frameBoxModel,
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    const boxes = await readWithheldFrameBoxes(
      session,
      FRAMES,
      [{ frameId: 'f1', origin: 'https://pay.example.com' }],
      { offset: offsetOf(-10, -20) }
    );

    expect(boxes).toStrictEqual({ boxes: [{ height: 200, left: 30, top: 40, width: 200 }] });
  });

  it('fails the capture when a withheld box cannot be measured', async () => {
    const session = createFakeSession({
      'DOM.getFrameOwner': () => ({}),
    });

    const boxes = await readWithheldFrameBoxes(session, FRAMES, [
      { frameId: 'f1', origin: 'https://pay.example.com' },
    ]);

    expect(boxes).toHaveProperty('error');
    expect('boxes' in boxes).toBe(false);
  });

  it('derives the device scale from the layout metrics', async () => {
    const session = createFakeSession({
      'Page.getLayoutMetrics': () => ({
        cssLayoutViewport: { clientWidth: 800 },
        cssVisualViewport: { pageX: 12, pageY: 34 },
        layoutViewport: { clientWidth: 1600 },
      }),
    });

    await expect(readAgentScreenshotGeometry(session, { fullPage: false })).resolves.toStrictEqual({
      offset: offsetOf(-12, -34),
      scale: 2,
    });
    expect(screenshotScale({ imageWidth: undefined, layoutWidth: 800 })).toBe(1);
  });
});

describe('sensitive field masking', () => {
  const probePayload = JSON.stringify({
    // prettier-ignore
    boxes: [{ height: 20, width: 120, 'x': 30, 'y': 40 }],
    scrollX: 5,
    scrollY: 7,
  });

  it('translates a password field box into document coordinates', async () => {
    const session = createFakeSession({
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { value: probePayload } }),
    });

    await expect(
      readSensitiveFieldBoxes(session, FRAMES, ['https://app.example.com'], {
        offset: offsetOf(-1, -2),
      })
    ).resolves.toStrictEqual({ boxes: [{ height: 20, left: 34, top: 45, width: 120 }] });
  });

  it('adds the iframe origin for a field inside a readable frame', async () => {
    const session = createFakeSession({
      'DOM.getBoxModel': () => ({
        model: { content: [40, 60, 240, 60, 240, 260, 40, 260], height: 200, width: 200 },
      }),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { value: probePayload } }),
    });

    const result = await readSensitiveFieldBoxes(session, FRAMES, [
      'https://app.example.com',
      'https://pay.example.com',
    ]);

    // The main frame's field sits at its own scroll-adjusted position; the child frame's adds the iframe's content origin.
    expect(result).toStrictEqual({
      boxes: [
        { height: 20, left: 35, top: 47, width: 120 },
        { height: 20, left: 75, top: 107, width: 120 },
      ],
    });
  });

  it('refuses the capture when a field frame cannot be measured', async () => {
    const session = createFakeSession({
      'DOM.getFrameOwner': () => ({}),
      'Page.createIsolatedWorld': () => ({ executionContextId: 9 }),
      'Runtime.evaluate': () => ({ result: { value: probePayload } }),
    });

    const result = await readSensitiveFieldBoxes(session, FRAMES, [
      'https://app.example.com',
      'https://pay.example.com',
    ]);

    expect(result).toHaveProperty('error');
  });
});

describe('console and network filtering', () => {
  const messages: readonly BrowserConsoleMessage[] = [
    { level: 'error', text: 'from frame', url: 'https://pay.example.com/widget.js' },
    { level: 'log', text: 'from page', url: 'https://app.example.com/app.js' },
    { level: 'log', text: 'no source' },
  ];

  it('drops console entries from withheld frames only', () => {
    expect(
      filterAgentConsoleMessages(messages, [
        { frameId: 'f1', origin: 'https://pay.example.com' },
      ]).map(message => message.text)
    ).toStrictEqual(['from page', 'no source']);
    expect(filterAgentConsoleMessages(messages, [])).toBe(messages);
  });

  it('drops network requests by the frame id the buffer records', () => {
    const requests = [
      { frameId: 'f1', requestId: '1', url: 'https://pay.example.com/charge' },
      { frameId: 'main', requestId: '2', url: 'https://app.example.com/app.js' },
      { requestId: '3', url: 'https://cdn.example.com/x.js' },
    ];

    expect(
      filterAgentNetworkRequests(requests, [
        { frameId: 'f1', origin: 'https://pay.example.com' },
      ]).map(request => request.requestId)
    ).toStrictEqual(['2', '3']);
  });
});
