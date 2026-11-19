/* eslint-disable id-length -- a pixel coordinate is x and y, and the page's own attributes are the ones it sets */
/* eslint-disable import/no-nodejs-modules -- the harness serves fixture pages over a real socket */
/* eslint-disable max-lines -- one measured cycle, its fixture page and its two device-pixel-ratio runs belong together */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { enableLocalAgents, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentSession, LocalAgentToolResponse } from './local-agents-fixture';

/*
 * The background-tab screenshot budget (SPEC "Browser tools"): the agent's own
 * tab is never activated, and Chrome renders an inactive tab about one frame a
 * second, so a plain `Page.captureScreenshot` of a page that just changed waits
 * for that frame — measured at 0.8-1.0 s through this same runtime. The
 * screenshot path takes the frame the compositor is forced to make instead.
 *
 * Every number here is a real tool call over the loopback hub the CLI uses, on
 * a tab the browser reports as inactive: 20 click-then-screenshot cycles, each
 * screenshot's pixel checked against the colour that click painted, and the
 * user's active tab asserted unchanged around every capture.
 */

const TOGGLE_LABEL = 'Toggle colour';
/** The two colours the toggle alternates, in click order. */
const COLOURS = [
  { blue: 0, green: 0, red: 255 },
  { blue: 0, green: 128, red: 0 },
] as const;
const CYCLES = 20;
const FRAME_BOX = { height: 160, left: 420, top: 220, width: 300 };
/** A page pixel outside the button (which ends at x=260) and outside the frame. */
const BODY_PIXEL = { x: 300, y: 30 };
const FRAME_PIXEL = { x: FRAME_BOX.left + 150, y: FRAME_BOX.top + 80 };

const pageHtml = (frameOrigin: string): string =>
  [
    '<style>html,body{margin:0;height:100%;background:#0000ff}</style>',
    `<button id="toggle" style="position:fixed;left:20px;top:20px;width:240px;height:100px;font-size:24px">${TOGGLE_LABEL}</button>`,
    `<iframe id="pay" src="${frameOrigin}/frame" style="border:0;height:${String(FRAME_BOX.height)}px;left:${String(FRAME_BOX.left)}px;position:fixed;top:${String(FRAME_BOX.top)}px;width:${String(FRAME_BOX.width)}px"></iframe>`,
    `<script>
      const colours = ['#ff0000', '#008000'];
      let next = 0;
      document.getElementById('toggle').addEventListener('click', () => {
        document.body.style.background = colours[next];
        next = (next + 1) % colours.length;
      });
    </script>`,
  ].join('');

/** The ref the snapshot gave the toggle, so the click addresses the element the snapshot showed. */
const toggleRefOf = (snapshotText: string): string => {
  const match = new RegExp(`- button "${TOGGLE_LABEL}" \\[ref=(e\\d+)\\]`, 'u').exec(snapshotText);

  if (match?.[1] === undefined) {
    throw new Error(`no toggle ref in snapshot: ${snapshotText}`);
  }

  return match[1];
};

const resultOf = (
  response: LocalAgentToolResponse
): Extract<LocalAgentToolResponse, { kind: 'result' }> => {
  if (response.kind !== 'result') {
    throw new Error(`unexpected protocol error: ${JSON.stringify(response)}`);
  }

  return response;
};

const screenshotDataUrl = (response: LocalAgentToolResponse): string => {
  const result = resultOf(response);

  if (result.image === undefined) {
    throw new Error(`no screenshot in ${JSON.stringify(response)}`);
  }

  return `data:${result.image.mimeType};base64,${result.image.data}`;
};

const readPixel = (
  extensionPage: Page,
  input: { readonly dataUrl: string; readonly x: number; readonly y: number }
): Promise<number[]> =>
  extensionPage.evaluate(
    async target => {
      const image = new Image();

      image.src = target.dataUrl;
      await image.decode();

      const canvas = document.createElement('canvas');

      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');

      if (context === null) {
        throw new Error('no 2d context');
      }

      context.drawImage(image, 0, 0);

      return [...context.getImageData(target.x, target.y, 1, 1).data];
    },
    { dataUrl: input.dataUrl, x: input.x, y: input.y }
  );

/** The image's own pixel size, so the capture can be checked against the CSS viewport it is of. */
const readImageSize = (
  extensionPage: Page,
  dataUrl: string
): Promise<{ readonly height: number; readonly width: number }> =>
  extensionPage.evaluate(async source => {
    const image = new Image();

    image.src = source;
    await image.decode();

    return { height: image.height, width: image.width };
  }, dataUrl);

interface TabRow {
  readonly active: boolean;
  readonly id: number;
  readonly url: string;
}

/** Every open tab with its url and focus state, read through the extension's own API. */
const openTabs = (extensionPage: Page): Promise<TabRow[]> =>
  extensionPage.evaluate(
    "chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ active: tab.active === true, id: tab.id ?? 0, url: tab.url || '' })))"
  );

const activeTabId = async (extensionPage: Page): Promise<number> => {
  const tabs = await openTabs(extensionPage);

  return tabs.find(tab => tab.active)?.id ?? 0;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].toSorted((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The index of the palette entry the pixel matches, so a repainted body is what the image shows. */
const colourIndexOf = (rgb: readonly number[]): number =>
  COLOURS.map((colour, index) => ({
    distance:
      Math.abs(colour.red - (rgb[0] ?? -255)) +
      Math.abs(colour.green - (rgb[1] ?? -255)) +
      Math.abs(colour.blue - (rgb[2] ?? -255)),
    index,
  })).toSorted((left, right) => left.distance - right.distance)[0]?.index ?? -1;

/** The gate a capture must beat: a forced frame lands in tens of ms, a throttled one near a second. */
const FAST_CAPTURE_MS = 150;

/**
 * The whole background-tab cycle: the agent's own inactive tab is navigated,
 * clicked and captured `cycles` times, and every image is checked for the colour
 * that click painted and for the mask over the frame whose origin was never
 * granted. The user's active tab is asserted unchanged around every capture.
 * `devicePixelRatio` is the ratio the browser must really render at, so a
 * high-DPI run proves its own state instead of assuming it.
 */
const runBackgroundTabScreenshot = async ({
  cycles,
  devicePixelRatio,
  extraLaunchArgs,
  label,
  realViewport,
  scale,
}: {
  readonly cycles: number;
  readonly devicePixelRatio: number;
  readonly extraLaunchArgs: readonly string[] | undefined;
  /** The prefix of the line the measured numbers are printed under. */
  readonly label: string;
  /** `true` drops Playwright's viewport emulation, so the browser renders at the scale it was launched with. */
  readonly realViewport: boolean;
  /** The tool's `scale`: `css` images are the viewport in CSS pixels, `device` images in the tab's own pixels. */
  readonly scale: 'css' | 'device';
}): Promise<void> => {
  // 127.0.0.2 is a different site from the page's 127.0.0.1, so Chromium renders the frame out of process.
  const inner = await startFixtureServer({
    bodyHtml: '<p>payment frame</p>',
    host: '127.0.0.2',
    title: 'Payment frame',
  });
  const outer = await startFixtureServer({
    bodyHtml: pageHtml(new URL(inner.url).origin),
    title: 'Background tab fixture',
  });
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({
    ...(extraLaunchArgs === undefined ? {} : { extraLaunchArgs }),
    ...(realViewport ? { realViewport } : {}),
    // Measure the browser a user actually has: Playwright's defaults keep Chrome from throttling an
    // Inactive tab, which removes both the frame-rate limit and the capture wait this test is about.
    ignoreDefaultArgs: [
      // Playwright launches Chrome with its own screenshot surface and with background throttling off, so
      // An inactive tab keeps painting. The extension captures through chrome.debugger, i.e. the path a
      // User's Chrome has, so the spec drops those defaults to measure that path.
      '--enable-features=CDPScreenshotNewSurface',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  await mockKiloApi(context, {});
  // A real user answers the optional-permission prompt; automation cannot, so the page grants it the way an accepted prompt would.
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const userPage = await context.newPage();

    await userPage.goto(`${outer.url}/user`);
    await userPage.bringToFront();

    // The image is in device pixels, so a CSS coordinate lands on `devicePixelRatio` times the pixel.
    expect(await userPage.evaluate('window.devicePixelRatio')).toBe(devicePixelRatio);

    const extensionPage = await context.newPage();

    // Nothing is shared: the agent's first navigate opens its own tab, inactive.
    const session: LocalAgentSession = await openPairedAgentSession({
      context,
      enableSwitch: () => enableLocalAgents(extensionPage, extensionId),
      extensionId,
      hub,
      share: false,
      sidePanel: extensionPage,
      title: 'Background tab screenshot',
    });
    const outerOrigin = new URL(outer.url).origin;
    const grants = [
      { class: 'act', origin: outerOrigin },
      { class: 'navigate', origin: outerOrigin },
      { class: 'read', origin: outerOrigin },
    ];
    const userTabId = await activeTabId(extensionPage);

    expect(session.tabId).toBe(0);

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${outer.url}/agent` },
      grants
    );

    expect(resultOf(navigated).isError, JSON.stringify(navigated)).toBe(false);
    const snapshot = await session.callTool('browser_snapshot', {}, grants);

    expect(resultOf(snapshot).text).toContain(TOGGLE_LABEL);

    const toggleRef = toggleRefOf(resultOf(snapshot).text);
    const tabs = await openTabs(extensionPage);
    const agentTab = tabs.find(tab => tab.url.endsWith('/agent'));

    // The tab the agent drives is its own, and the browser does not report it as active.
    expect(agentTab?.active).toBe(false);
    expect(agentTab?.id).not.toBe(userTabId);
    expect(await activeTabId(extensionPage)).toBe(userTabId);

    const agentPage = context.pages().find(page => page.url().endsWith('/agent'));

    if (agentPage === undefined) {
      throw new Error('the agent tab is not among the context pages');
    }

    // The tab these images are of renders at the ratio the image is measured at, not just the user's page.
    expect(await agentPage.evaluate('window.devicePixelRatio')).toBe(devicePixelRatio);
    const cssViewport = await agentPage.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    // A css-scale image is the viewport in CSS pixels; a device-scale one is the tab's own pixels. Every pixel
    // Coordinate below is read at the ratio the image really has, so both asserts measure the same page.
    const imageRatio = scale === 'device' ? devicePixelRatio : 1;

    const samples: number[] = [];
    let maskedFramePixel: number[] = [];
    let imageSummary = 'image=unmeasured';

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop -- one click-then-shot cycle at a time
      const clicked = await session.callTool(
        'browser_click',
        { element: TOGGLE_LABEL, target: toggleRef },
        grants
      );

      expect(resultOf(clicked).isError, JSON.stringify(clicked)).toBe(false);

      const started = Date.now();
      // eslint-disable-next-line no-await-in-loop -- the shot is what this test times
      const shot = await session.callTool(
        'browser_take_screenshot',
        { scale, type: 'png' },
        grants
      );
      const elapsed = Date.now() - started;
      const dataUrl = screenshotDataUrl(shot);

      samples.push(elapsed);

      if (cycle === 0) {
        // The image's size is the documentation of its own scale: CSS pixels for `css`, the tab's for `device`.
        // eslint-disable-next-line no-await-in-loop -- one decode of the first image
        const imageSize = await readImageSize(extensionPage, dataUrl);

        expect(
          imageSize,
          `image ${String(imageSize.width)}x${String(imageSize.height)} for a ${String(cssViewport.width)}x${String(cssViewport.height)} viewport at ${String(devicePixelRatio)}x and scale "${scale}"`
        ).toEqual({
          height: cssViewport.height * imageRatio,
          width: cssViewport.width * imageRatio,
        });
        imageSummary = `image=${String(imageSize.width)}x${String(imageSize.height)} viewport=${String(cssViewport.width)}x${String(cssViewport.height)} scale=${scale}`;
      }

      // eslint-disable-next-line no-await-in-loop -- decoding one image at a time
      const pixel = await readPixel(extensionPage, {
        dataUrl,
        x: BODY_PIXEL.x * imageRatio,
        y: BODY_PIXEL.y * imageRatio,
      });

      // The image is the page after this click, not the frame that was last presented.
      expect(
        colourIndexOf(pixel.slice(0, 3)),
        `cycle ${String(cycle)} pixel ${JSON.stringify(pixel)} after ${String(elapsed)} ms`
      ).toBe(cycle % COLOURS.length);
      // The frame's origin was never granted, so the post-click shot still blacks it out — at the image's own
      // Ratio, which is what puts the mask geometry on the right pixels at a ratio other than 1.
      // eslint-disable-next-line no-await-in-loop -- decoding one image at a time
      maskedFramePixel = await readPixel(extensionPage, {
        dataUrl,
        x: FRAME_PIXEL.x * imageRatio,
        y: FRAME_PIXEL.y * imageRatio,
      });
      expect(maskedFramePixel.slice(0, 3)).toEqual([0, 0, 0]);
      // eslint-disable-next-line no-await-in-loop -- one capture at a time
      expect(await activeTabId(extensionPage)).toBe(userTabId);
    }

    const fast = samples.filter(elapsed => elapsed < FAST_CAPTURE_MS).length;
    const summary = `median=${String(median(samples))}ms fast=${String(fast)}/${String(cycles)} ${imageSummary} samples=${JSON.stringify(samples)}`;

    // eslint-disable-next-line no-console -- the numbers are what this test measures
    console.warn(`${label} ${summary}`);
    expect(maskedFramePixel[3]).toBe(255);
    // Waiting for the throttled frame lands near a second; a forced frame lands in tens of ms. The gate is the
    // Median, so one capture that misses the forced-frame bound and falls back does not fail the spec; the count
    // Is what keeps the fast path itself asserted for most captures.
    expect(median(samples), summary).toBeLessThan(FAST_CAPTURE_MS);
    expect(fast, summary).toBeGreaterThanOrEqual(Math.ceil(cycles * 0.8));
  } finally {
    await context.close();
    await hub.close();
    await inner.close();
    await outer.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
};

test('a screenshot of the agent\u2019s own inactive tab is fresh and fast, and never takes the user\u2019s tab', async () => {
  test.setTimeout(240_000);

  await runBackgroundTabScreenshot({
    cycles: CYCLES,
    devicePixelRatio: 1,
    extraLaunchArgs: undefined,
    label: 'background tab screenshot',
    realViewport: false,
    scale: 'css',
  });
});

test('a css-scale screenshot stays fresh, fast and masked at device pixel ratio 2', async () => {
  test.setTimeout(180_000);

  // The renderer really is a high-DPI one here: the image's documented size is still the CSS viewport, and the mask
  // Geometry is laid over it, so a capture path that only gets the scale right at DPR 1 shows up as the wrong pixels.
  await runBackgroundTabScreenshot({
    cycles: 5,
    devicePixelRatio: 2,
    // With no viewport emulation the window is the page: a pinned 800x520 holds the fixture's 720x380
    // Frame box at ~800x433 css pixels, and keeps the size the same in a headed xvfb run and in headless ci.
    extraLaunchArgs: ['--force-device-scale-factor=2', '--window-size=800,520'],
    label: 'dpr2 css background tab screenshot',
    realViewport: true,
    scale: 'css',
  });
});

test('a device-scale screenshot is the tab\u2019s own pixels at device pixel ratio 2', async () => {
  test.setTimeout(180_000);

  // The same tab, asked for its device pixels: the image is twice the CSS viewport and the mask covers twice the box.
  await runBackgroundTabScreenshot({
    cycles: 5,
    devicePixelRatio: 2,
    extraLaunchArgs: ['--force-device-scale-factor=2', '--window-size=800,520'],
    label: 'dpr2 device background tab screenshot',
    realViewport: true,
    scale: 'device',
  });
});
