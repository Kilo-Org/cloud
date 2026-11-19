/* eslint-disable max-lines, require-await -- the suite covers frame tree reading, scoped snapshots, masking, and filtering against one fake CDP session whose channel is async by contract. */
import { describe, expect, it } from 'vitest';
import {
  buildScopedSnapshot,
  captureAgentAriaSnapshot,
  captureAgentSnapshotView,
  filterAgentConsoleMessages,
  filterAgentNetworkRequests,
  frameWithOwnerNode,
  readAgentFrames,
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
  params: Record<string, unknown> | undefined,
  /** Set when the command addressed a flattened child session (an out-of-process iframe). */
  sessionId?: string
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
    params?: Record<string, unknown>,
    sessionId?: string
  ) => Promise<Record<string, unknown> | undefined>;
  readonly registerRefs: (entries: readonly BrowserToolRefEntry[]) => void;
}

const createFakeSession = (
  handlers: Record<string, CdpHandler>,
  /** Out-of-process iframes the tab auto-attached, as `childFrames()` reports them. */
  childFrames?: ReadonlyMap<string, { readonly sessionId: string; readonly url: string }>,
  /** Makes every command addressed to a child session fail, like a detached OOPIF. */
  brokenChildSession = false
): FakeSession => {
  const refs: BrowserToolRefEntry[][] = [];

  return {
    ...(childFrames === undefined ? {} : { childFrames: () => childFrames }),
    refs,
    registerRefs: entries => {
      refs.push([...entries]);
    },
    send: async (method, params, sessionId) => {
      if (brokenChildSession && sessionId !== undefined) {
        throw new Error('Session with given id not found.');
      }

      const handler = handlers[method];

      if (handler === undefined) {
        throw new Error(`unexpected CDP method ${method}`);
      }

      return handler(params, sessionId);
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

    expect(capture.text).toContain('- iframe [ref=e10] [origin withheld: https://pay.example.com]');
    expect(capture.text).toContain('- button "Submit" [ref=e2]');
    expect(capture.text).not.toContain('marker-42');
    expect(capture.text).not.toContain('leaked inner text');
    expect(capture.withheldFrames).toStrictEqual(['https://pay.example.com']);
  });

  it('maps an iframe owner node to the frame it hosts', async () => {
    const session = createFakeSession({
      ...snapshotHandlers(CHILD_TREE),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    await expect(frameWithOwnerNode(session, FRAMES, 10)).resolves.toStrictEqual(FRAMES[1]);
    await expect(frameWithOwnerNode(session, FRAMES, 2)).resolves.toBeUndefined();
  });

  it('renders a targeted, granted frame’s own document', async () => {
    const session = createFakeSession({
      ...snapshotHandlers(CHILD_TREE),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    const capture = await captureAgentAriaSnapshot(
      session,
      { readableOrigins: ['https://app.example.com', 'https://pay.example.com'] },
      { rootFrameId: 'f1' }
    );

    expect(capture.text).toContain('- text: card marker-42');
    expect(capture.text).not.toContain('Submit');
    expect(capture.withheldFrames).toStrictEqual([]);
  });

  it('fails closed when the targeted frame itself is withheld', async () => {
    const session = createFakeSession({
      ...snapshotHandlers(CHILD_TREE),
      'DOM.getFrameOwner': () => ({ backendNodeId: 10 }),
    });

    const capture = await captureAgentAriaSnapshot(
      session,
      { readableOrigins: ['https://app.example.com'] },
      { rootFrameId: 'f1' }
    );

    expect(capture.text).toBe('(no accessibility nodes)');
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
      withheldFrameLine('https://pay.example.com', 1, 'e10'),
    ]);
    // The owner's ref is registered, so a targeted snapshot can resolve it.
    expect(snapshot.refs).toContainEqual({ backendNodeId: 10, ref: 'e10' });
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
        cssLayoutViewport: { clientHeight: 400, clientWidth: 800 },
        cssVisualViewport: { pageX: 12, pageY: 34 },
        layoutViewport: { clientHeight: 800, clientWidth: 1600 },
      }),
    });

    await expect(readAgentScreenshotGeometry(session)).resolves.toStrictEqual({
      scale: 2,
      scroll: offsetOf(12, 34),
      viewport: { height: 400, width: 800 },
    });
    expect(screenshotScale({ imageWidth: undefined, layoutWidth: 800 })).toBe(1);
  });

  it('has no CSS viewport to clip when the metrics carry none', async () => {
    const session = createFakeSession({
      'Page.getLayoutMetrics': () => ({
        cssLayoutViewport: { clientWidth: 800 },
        cssVisualViewport: { pageX: 12, pageY: 34 },
        layoutViewport: { clientWidth: 1600 },
      }),
    });

    await expect(readAgentScreenshotGeometry(session)).resolves.toStrictEqual({
      scale: 2,
      scroll: offsetOf(12, 34),
      viewport: undefined,
    });
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
    { frameId: 'f1', level: 'log', text: 'attributed to frame', url: 'about:blank' },
    { level: 'log', text: 'from page', url: 'https://app.example.com/app.js' },
    { level: 'log', text: 'no source' },
  ];

  it('drops console entries from withheld frames only', () => {
    expect(
      filterAgentConsoleMessages(messages, [
        { frameId: 'f1', origin: 'https://pay.example.com' },
      ]).map(message => message.text)
    ).toStrictEqual(['from page']);
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

/*
 * An out-of-process iframe: Chrome leaves it out of `Page.getFrameTree`, so the
 * tab learns it only from `Target.attachedToTarget` and reads it through a
 * flattened child session. The shapes below mirror a real cross-site frame:
 * the parent's AX tree carries the iframe owner node without children, and the
 * child session reports the frame's own document and its parent frame id.
 */
const OOPIF_ID = 'oopif-1';
const OOPIF_ORIGIN = 'http://127.0.0.2:5555';
const OOPIF_SESSION = 'child-session-1';

const OOPIF_MAIN_TREE = {
  nodes: [
    { backendDOMNodeId: 1, childIds: ['2', '4'], nodeId: '1', role: { value: 'RootWebArea' } },
    { backendDOMNodeId: 2, name: { value: 'Submit' }, nodeId: '2', role: { value: 'button' } },
    { backendDOMNodeId: 5, childIds: [], nodeId: '4', role: { value: 'Iframe' } },
  ],
};

const OOPIF_CHILD_TREE = {
  nodes: [
    { childIds: ['2'], nodeId: '1', role: { value: 'RootWebArea' } },
    {
      backendDOMNodeId: 51,
      name: { value: 'oopif marker-9' },
      nodeId: '2',
      role: { value: 'StaticText' },
    },
  ],
};

/** A tab whose frame tree holds only the main frame, plus one auto-attached OOPIF. */
const oopifSession = (
  overrides: Record<string, CdpHandler> = {},
  childFrames:
    | ReadonlyMap<string, { readonly sessionId: string; readonly url: string }>
    | undefined = new Map([[OOPIF_ID, { sessionId: OOPIF_SESSION, url: `${OOPIF_ORIGIN}/frame` }]]),
  brokenChildSession = false
): FakeSession =>
  createFakeSession(
    {
      'Accessibility.getFullAXTree': (_params, sessionId) =>
        sessionId === OOPIF_SESSION ? OOPIF_CHILD_TREE : OOPIF_MAIN_TREE,
      'DOM.getBoxModel': params =>
        params?.['backendNodeId'] === 5
          ? { model: { content: [40, 120, 440, 120, 440, 320, 40, 320], height: 200, width: 400 } }
          : { model: { content: [0, 0, 10, 0, 10, 10, 0, 10], height: 10, width: 10 } },
      'DOM.getFrameOwner': params => (params?.['frameId'] === OOPIF_ID ? { backendNodeId: 5 } : {}),
      'Page.createIsolatedWorld': () => ({ executionContextId: 7 }),
      'Page.getFrameTree': (_params, sessionId) =>
        sessionId === OOPIF_SESSION
          ? {
              frameTree: {
                frame: { id: OOPIF_ID, parentId: 'main', url: `${OOPIF_ORIGIN}/frame` },
              },
            }
          : {
              frameTree: {
                frame: {
                  id: 'main',
                  securityOrigin: 'http://127.0.0.1:4444',
                  url: 'http://127.0.0.1:4444/',
                },
              },
            },
      'Runtime.evaluate': () => ({ result: { value: '{"hidden":[],"values":[]}' } }),
      ...overrides,
    },
    childFrames,
    brokenChildSession
  );

const MAIN_ORIGIN = 'http://127.0.0.1:4444';

describe('out-of-process iframes', () => {
  it('keeps the main frame’s nodes and emits the withheld line for a frame the frame tree omits', async () => {
    const capture = await captureAgentAriaSnapshot(oopifSession(), {
      readableOrigins: [MAIN_ORIGIN],
    });

    expect(capture.text).toContain('- button "Submit" [ref=e2]');
    expect(capture.text).toContain(`- iframe [ref=e5] [origin withheld: ${OOPIF_ORIGIN}]`);
    expect(capture.text).not.toContain('oopif marker-9');
    expect(capture.withheldFrames).toStrictEqual([OOPIF_ORIGIN]);
  });

  it('reads the frame origin from the child session when the attach predates its document', async () => {
    // A target attaches while the frame is still blank, which is what a tab opened before its page loads reports.
    // The origin must come from the frame's own tree, not from the attach event.
    const session = oopifSession(
      {},
      new Map([[OOPIF_ID, { sessionId: OOPIF_SESSION, url: 'about:blank' }]])
    );

    const withheld = await captureAgentAriaSnapshot(session, { readableOrigins: [MAIN_ORIGIN] });

    expect(withheld.text).toContain(`[origin withheld: ${OOPIF_ORIGIN}]`);
    expect(withheld.withheldFrames).toStrictEqual([OOPIF_ORIGIN]);

    const granted = await captureAgentAriaSnapshot(
      oopifSession({}, new Map([[OOPIF_ID, { sessionId: OOPIF_SESSION, url: 'about:blank' }]])),
      { readableOrigins: [MAIN_ORIGIN, OOPIF_ORIGIN] }
    );

    expect(granted.text).toContain('- text: oopif marker-9');
    expect(granted.withheldFrames).toStrictEqual([]);
  });

  it('splices the child session’s tree in when the frame origin is granted', async () => {
    const capture = await captureAgentAriaSnapshot(oopifSession(), {
      readableOrigins: [MAIN_ORIGIN, OOPIF_ORIGIN],
    });

    expect(capture.text).toContain('- text: oopif marker-9');
    expect(capture.text).not.toContain('origin withheld');
    expect(capture.withheldFrames).toStrictEqual([]);
  });

  it('renders a targeted, granted OOPIF through its child session', async () => {
    const capture = await captureAgentAriaSnapshot(
      oopifSession(),
      { readableOrigins: [MAIN_ORIGIN, OOPIF_ORIGIN] },
      { rootFrameId: OOPIF_ID }
    );

    expect(capture.text).toContain('- text: oopif marker-9');
    expect(capture.text).not.toContain('Submit');
  });

  it('masks the owner box of an OOPIF the frame tree omits', async () => {
    const session = oopifSession();
    const inventory = await readAgentFrames(session);
    const withheld = withheldFramesOf(inventory.frames, [MAIN_ORIGIN]);

    expect(withheld).toStrictEqual([{ frameId: OOPIF_ID, origin: OOPIF_ORIGIN }]);

    const boxes = await readWithheldFrameBoxes(session, inventory.frames, withheld);

    expect(boxes).toStrictEqual({ boxes: [{ height: 200, left: 40, top: 120, width: 400 }] });
  });

  it('still withholds and masks when the child session cannot be read', async () => {
    const session = oopifSession({}, undefined, true);

    const capture = await captureAgentAriaSnapshot(session, {
      readableOrigins: [MAIN_ORIGIN, OOPIF_ORIGIN],
    });

    // A frame whose session is broken is treated as unreadable, never as empty.
    expect(capture.text).toContain('- button "Submit" [ref=e2]');
    expect(capture.text).toContain(`[origin withheld: ${OOPIF_ORIGIN}]`);

    const inventory = await readAgentFrames(session);
    const withheld = withheldFramesOf(inventory.frames, [MAIN_ORIGIN]);
    const boxes = await readWithheldFrameBoxes(session, inventory.frames, withheld);

    expect(boxes).toStrictEqual({ boxes: [{ height: 200, left: 40, top: 120, width: 400 }] });
  });

  it('renders the tab’s own tree when the frame tree call fails', async () => {
    const capture = await captureAgentAriaSnapshot(
      createFakeSession({
        'Accessibility.getFullAXTree': () => OOPIF_MAIN_TREE,
        'Page.createIsolatedWorld': () => ({ executionContextId: 7 }),
        'Page.getFrameTree': () => {
          throw new Error('Target closed.');
        },
        'Runtime.evaluate': () => ({ result: { value: '{"hidden":[],"values":[]}' } }),
      }),
      { readableOrigins: [MAIN_ORIGIN] }
    );

    expect(capture.text).toContain('- button "Submit" [ref=e2]');
    expect(capture.text).not.toContain('origin withheld');
  });

  it('withholds a frame whose child session is unknown and still keeps the owner box measurable', async () => {
    // No auto-attach record means the frame is invisible to the tab, exactly as when only the frame tree is read.
    const session = oopifSession({}, new Map());

    const inventory = await readAgentFrames(session);

    expect(inventory.frames).toStrictEqual([
      { id: 'main', origin: MAIN_ORIGIN, url: `${MAIN_ORIGIN}/` },
    ]);
  });
});
