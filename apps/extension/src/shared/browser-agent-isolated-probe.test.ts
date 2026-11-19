/* eslint-disable import/no-nodejs-modules, max-lines, no-new-func, typescript/no-implied-eval, typescript/no-unsafe-call, typescript/no-unsafe-type-assertion -- the probe is injected as its own source; running that exact source against a test DOM is the point, and the in-page cases and the mask cases read one fixture set */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  maskIsolatedAgentScreenshot,
  readIsolatedFrames,
  readIsolatedScreenshotMask,
} from './browser-agent-isolated-probe';
import type { IsolatedAgentProbe, IsolatedProbeResult } from './browser-agent-isolated-probe';
import { runIsolatedAgentProbe } from './browser-agent-isolated-probe-script';
import { classifyFocusedElement, classifyTargetElement } from './browser-agent-probes';
import { readAgentFrames } from './browser-agent-frames';
import { preflightAgentCall } from './browser-agent-gate';
import { SENSITIVE_REASON } from './browser-agent-checks';

/** Runs the probe's own serialized source in a jsdom page, the way `scripting.executeScript` ships it. */
const runInPage = (
  html: string,
  kind: string,
  page: {
    /** The document's MIME type; `application/xhtml+xml` makes element names case-sensitive. */
    readonly contentType?: string;
    readonly frameIdOf?: (target: unknown) => number;
    readonly selector?: string;
    /** Builds what markup cannot: shadow roots, layout boxes, Firefox-only element members. */
    readonly setup?: (window: JSDOM['window']) => void;
  } = {}
): unknown => {
  const dom = new JSDOM(html, {
    contentType: page.contentType ?? 'text/html',
    url: 'https://shop.example.com/cart',
  });
  page.setup?.(dom.window);
  const run = new Function(
    'document',
    'location',
    'window',
    'HTMLIFrameElement',
    'globalThis',
    'kind',
    'selector',
    `return (${runIsolatedAgentProbe.toString()})(kind, selector);`
  );

  return JSON.parse(
    String(
      run(
        dom.window.document,
        dom.window.location,
        dom.window,
        dom.window.HTMLIFrameElement,
        { browser: { runtime: { getFrameId: page.frameIdOf ?? (() => -1) } } },
        kind,
        page.selector ?? ''
      )
    )
  );
};

/** A probe that answers every frame from a fixed table, ignoring frames it was not asked for. */
const fakeProbe =
  (answers: Record<number, Record<string, unknown>>): IsolatedAgentProbe =>
  (request, frameIds) => {
    const results: IsolatedProbeResult[] = [];

    for (const [frameId, byKind] of Object.entries(answers)) {
      const id = Number(frameId);
      const answer = byKind[request.kind];

      if ((frameIds === undefined || frameIds.includes(id)) && answer !== undefined) {
        results.push({ frameId: id, result: JSON.stringify(answer) });
      }
    }

    return Promise.resolve(results);
  };

const sessionWith = (probe: IsolatedAgentProbe) => ({
  isolatedProbe: probe,
  resolveTarget: (target: string) =>
    Promise.resolve({ kind: 'selector' as const, nodeId: 0, selector: target }),
  send: (): Promise<Record<string, unknown> | undefined> =>
    Promise.reject(
      new Error('send is not available in Firefox: this browser exposes no debugger protocol.')
    ),
});

describe('isolated agent probe in the page', () => {
  it('names a password field as sensitive and a plain button as plain', () => {
    const page = '<form><input id="pw" type="password"><button id="go">Go</button></form>';

    expect(runInPage(page, 'target', { selector: '#pw' })).toStrictEqual({
      probe: { fields: [{ kind: 'password' }], paymentFormSubmit: false },
    });
    expect(runInPage(page, 'target', { selector: '#go' })).toStrictEqual({
      probe: { fields: [], paymentFormSubmit: false },
    });
  });

  it('flags the submit button of a card form', () => {
    const page =
      '<form><input name="card-number" autocomplete="cc-number"><button id="pay">Pay</button></form>';

    expect(runInPage(page, 'target', { selector: '#pay' })).toStrictEqual({
      probe: { fields: [], paymentFormSubmit: true },
    });
  });

  it('answers nothing for a selector that names no single element', () => {
    expect(
      runInPage('<button>a</button><button>b</button>', 'target', { selector: 'button' })
    ).toStrictEqual({});
  });

  it('sees a password field in the frame', () => {
    expect(runInPage('<input type="password">', 'presence')).toStrictEqual({
      closed: false,
      present: true,
    });
  });

  it('maps each frame element to its frame id', () => {
    const page = '<iframe id="pay" src="https://pay.example.com/"></iframe>';

    expect(runInPage(page, 'boxes', { frameIdOf: () => 9 })).toMatchObject({
      owners: [{ frameId: 9 }],
    });
  });

  describe('screenshot boxes inside shadow roots', () => {
    const laidOut = (window: JSDOM['window']): void => {
      window.Element.prototype.getBoundingClientRect = function getBoundingClientRect(
        this: Element
      ) {
        return { height: 20, left: this.id.length, top: 10, width: 30 } as DOMRect;
      };
    };
    const shadowPage = '<div id="host-a"></div><x-pay id="host-bb"></x-pay>';
    const attach =
      (mode: 'closed' | 'open') =>
      (window: JSDOM['window']): readonly ShadowRoot[] => {
        const roots = ['host-a', 'host-bb'].map(id => {
          const host = window.document.querySelector(`#${id}`);

          if (host === null) {
            throw new Error(`missing ${id}`);
          }

          const root = host.attachShadow({ mode });
          root.innerHTML = '<iframe id="frame"></iframe><input id="pw" type="password">';
          return root;
        });

        laidOut(window);
        return roots;
      };

    it('reaches a frame and a password field inside an open shadow root', () => {
      expect(
        runInPage(shadowPage, 'boxes', {
          frameIdOf: () => 4,
          setup: window => {
            attach('open')(window);
          },
        })
      ).toStrictEqual({
        fields: [
          { height: 20, left: 2, top: 10, width: 30 },
          { height: 20, left: 2, top: 10, width: 30 },
        ],
        owners: [
          { box: { height: 20, left: 5, top: 10, width: 30 }, frameId: 4 },
          { box: { height: 20, left: 5, top: 10, width: 30 }, frameId: 4 },
        ],
      });
    });

    it('masks a custom element whole when its closed root cannot be opened', () => {
      expect(
        runInPage(shadowPage, 'boxes', {
          setup: window => {
            attach('closed')(window);
          },
        })
      ).toStrictEqual({ fields: [{ height: 20, left: 7, top: 10, width: 30 }], owners: [] });
    });

    it('reads a closed root through Firefox’s openOrClosedShadowRoot', () => {
      expect(
        runInPage(shadowPage, 'boxes', {
          frameIdOf: () => 6,
          setup: window => {
            const roots = attach('closed')(window);
            const byHost = new Map(roots.map(root => [root.host, root]));

            Object.defineProperty(window.Element.prototype, 'openOrClosedShadowRoot', {
              get(this: Element) {
                return byHost.get(this);
              },
            });
          },
        })
      ).toMatchObject({
        fields: [{ left: 2 }, { left: 2 }],
        owners: [{ frameId: 6 }, { frameId: 6 }],
      });
    });

    it('masks the frame and the password field of an XHTML page, whose element names are lower case', () => {
      const xhtml =
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
        '<iframe id="frame" src="https://pay.example.com/"></iframe>' +
        '<input id="pw" type="password"/>' +
        '</body></html>';

      expect(
        runInPage(xhtml, 'boxes', {
          contentType: 'application/xhtml+xml',
          frameIdOf: () => 8,
          setup: laidOut,
        })
      ).toStrictEqual({
        fields: [{ height: 20, left: 2, top: 10, width: 30 }],
        owners: [{ box: { height: 20, left: 5, top: 10, width: 30 }, frameId: 8 }],
      });
      expect(
        runInPage(xhtml, 'target', { contentType: 'application/xhtml+xml', selector: '#pw' })
      ).toStrictEqual({ probe: { fields: [{ kind: 'password' }], paymentFormSubmit: false } });
    });
  });

  it('reports its own url and origin, and the frame each frame element hosts', () => {
    expect(runInPage('<p>x</p>', 'frame')).toStrictEqual({
      origin: 'https://shop.example.com',
      owners: [],
      parentFrameId: null,
      url: 'https://shop.example.com/cart',
    });
    expect(
      runInPage('<iframe></iframe><p><iframe></iframe></p>', 'frame', { frameIdOf: () => 3 })
    ).toMatchObject({ owners: [3, 3] });
  });
});

describe('isolated frame list', () => {
  it('builds the frame tree from one injection per frame, main frame first', async () => {
    const probe = fakeProbe({
      0: {
        frame: {
          origin: 'https://shop.example.com',
          parentFrameId: null,
          url: 'https://shop.example.com/',
        },
      },
      12: {
        frame: {
          origin: 'https://pay.example.com',
          parentFrameId: 0,
          url: 'https://pay.example.com/form',
        },
      },
    });

    await expect(readAgentFrames(sessionWith(probe))).resolves.toStrictEqual({
      childSessions: new Map(),
      complete: true,
      frames: [
        { id: '0', origin: 'https://shop.example.com', url: 'https://shop.example.com/' },
        {
          id: '12',
          origin: 'https://pay.example.com',
          parentId: '0',
          url: 'https://pay.example.com/form',
        },
      ],
    });
  });

  it('is incomplete without the main frame, so the gate fails closed', async () => {
    const probe = fakeProbe({
      12: {
        frame: {
          origin: 'https://pay.example.com',
          parentFrameId: 0,
          url: 'https://pay.example.com/',
        },
      },
    });

    await expect(readIsolatedFrames(probe)).resolves.toMatchObject({ complete: false });
  });

  it('reads an opaque frame as opaque', async () => {
    const probe = fakeProbe({
      0: { frame: { origin: 'null', parentFrameId: null, url: 'about:blank' } },
    });

    await expect(readIsolatedFrames(probe)).resolves.toMatchObject({
      frames: [{ id: '0', origin: 'opaque:null' }],
    });
  });

  it('names the frame a frame element hosts, and nothing for any other element', () => {
    const page =
      '<iframe id="pay" src="https://pay.example.com/"></iframe><button id="go">Go</button>';

    expect(runInPage(page, 'hosted', { frameIdOf: () => 12, selector: '#pay' })).toStrictEqual({
      frameId: 12,
    });
    expect(runInPage(page, 'hosted', { frameIdOf: () => 12, selector: '#go' })).toStrictEqual({});
  });

  it('asks for the hosted frame’s read grant when a call targets its frame element', async () => {
    const probe = fakeProbe({
      0: {
        frame: {
          origin: 'https://shop.example.com',
          parentFrameId: null,
          url: 'https://shop.example.com/',
        },
        hosted: { frameId: 12 },
      },
      12: {
        frame: {
          origin: 'https://pay.example.com',
          parentFrameId: 0,
          url: 'https://pay.example.com/form',
        },
      },
    });

    await expect(
      preflightAgentCall({
        args: { target: '#pay' },
        authorized: [{ class: 'read', origin: 'https://shop.example.com' }],
        consumeStepToken: () => false,
        session: { ...sessionWith(probe), takeDownloads: () => [] },
        sessionHandle: 'session-1',
        stepTokens: [],
        tabId: 7,
        toolName: 'browser_snapshot',
      })
    ).resolves.toStrictEqual({
      failure: {
        items: [{ class: 'read', frame: true, origin: 'https://pay.example.com' }],
        kind: 'needs_permission',
      },
      ok: false,
    });
  });
});

describe('isolated sensitive classification', () => {
  it('classifies the targeted field through the probe, not the debugger', async () => {
    const probe = fakeProbe({
      0: { target: { probe: { fields: [{ kind: 'password' }], paymentFormSubmit: false } } },
    });

    await expect(classifyTargetElement(sessionWith(probe), '#pw')).resolves.toStrictEqual({
      kind: 'sensitive',
      reason: SENSITIVE_REASON.password,
    });
  });

  it('lets an ordinary button through as plain', async () => {
    const probe = fakeProbe({ 0: { target: { probe: { fields: [], paymentFormSubmit: false } } } });

    await expect(classifyTargetElement(sessionWith(probe), '#go')).resolves.toStrictEqual({
      kind: 'plain',
    });
  });

  it('treats a target the probe could not read as unknown', async () => {
    await expect(classifyTargetElement(sessionWith(fakeProbe({})), '#pw')).resolves.toMatchObject({
      kind: 'unknown',
    });
  });

  it('names the frame that holds focus when the page cannot look into it', async () => {
    const probe = fakeProbe({ 0: { focused: { frameId: 12 } } });

    await expect(classifyFocusedElement(sessionWith(probe))).resolves.toMatchObject({
      frameId: '12',
      kind: 'sensitive',
    });
  });
});

describe('isolated screenshot mask', () => {
  const frames = [
    { id: '0', origin: 'https://shop.example.com', url: 'https://shop.example.com/' },
    { id: '12', origin: 'https://pay.example.com', parentId: '0', url: 'https://pay.example.com/' },
  ];
  const owner = { box: { height: 200, left: 10, top: 20, width: 300 }, frameId: 12 };

  it('blacks out a frame the agent may not read', async () => {
    const probe = fakeProbe({ 0: { boxes: { fields: [], owners: [owner] } } });

    await expect(readIsolatedScreenshotMask(probe, frames, [])).resolves.toStrictEqual({
      boxes: [owner.box],
    });
  });

  it('shows a readable frame but still hides its sensitive fields at their page position', async () => {
    const probe = fakeProbe({
      0: { boxes: { fields: [], owners: [owner] } },
      12: { boxes: { fields: [{ height: 10, left: 5, top: 6, width: 50 }], owners: [] } },
    });

    await expect(
      readIsolatedScreenshotMask(probe, frames, ['https://pay.example.com'])
    ).resolves.toStrictEqual({ boxes: [{ height: 10, left: 15, top: 26, width: 50 }] });
  });

  it('blacks out a frame element whose document was never seen', async () => {
    const unseen = { box: { height: 50, left: 0, top: 0, width: 50 }, frameId: null };
    const probe = fakeProbe({ 0: { boxes: { fields: [], owners: [unseen] } } });

    await expect(
      readIsolatedScreenshotMask(probe, frames, ['https://pay.example.com'])
    ).resolves.toStrictEqual({ boxes: [unseen.box] });
  });

  it('returns no image when the page geometry cannot be read', async () => {
    await expect(
      maskIsolatedAgentScreenshot({
        capture: { ok: true, value: { dataUrl: 'data:image/png;base64,AAAA' } },
        frames,
        probe: fakeProbe({}),
        readableOrigins: [],
      })
    ).resolves.toMatchObject({ ok: false });
  });
});
