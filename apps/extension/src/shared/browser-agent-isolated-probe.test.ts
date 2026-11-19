/* eslint-disable import/no-nodejs-modules, no-new-func, typescript/no-implied-eval, typescript/no-unsafe-call, typescript/no-unsafe-type-assertion -- the probe is injected as its own source; running that exact source against a test DOM is the point */
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
import { SENSITIVE_REASON } from './browser-agent-checks';

/** Runs the probe's own serialized source in a jsdom page, the way `scripting.executeScript` ships it. */
const runInPage = (
  html: string,
  kind: string,
  page: { readonly frameIdOf?: (target: unknown) => number; readonly selector?: string } = {}
): unknown => {
  const dom = new JSDOM(html, { url: 'https://shop.example.com/cart' });
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

  it('reports its own url and origin', () => {
    expect(runInPage('<p>x</p>', 'frame')).toStrictEqual({
      origin: 'https://shop.example.com',
      parentFrameId: null,
      url: 'https://shop.example.com/cart',
    });
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
