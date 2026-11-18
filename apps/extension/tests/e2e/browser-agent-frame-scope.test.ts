/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import {
  activateTab,
  openPairedAgentSession,
  seedLocalAgentsEnabled,
} from './local-agents-fixture';
import type { LocalAgentToolResponse } from './local-agents-fixture';

/*
 * The end-to-end proof for agent frame scoping (SPEC "Frame scoping"): a
 * cross-origin iframe holds a marker string, and an agent session — opened and
 * shared through the hub exactly as the CLI does — sees the marker nowhere:
 * not in the snapshot, not in find, not in the screenshot's pixels, until the
 * iframe's origin gets its own `read` grant.
 */

const MARKER = 'KILO_FRAME_MARKER_42';
const IFRAME_BOX = { height: 200, left: 40, top: 120, width: 400 };

const originOf = (url: string): string => {
  const parsed = new URL(url);

  return `${parsed.protocol}//${parsed.host}`;
};

/** The tool result the assertions read; a protocol refusal is a test failure here. */
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
  input: { readonly dataUrl: string; readonly pixelX: number; readonly pixelY: number }
): Promise<number[]> =>
  extensionPage.evaluate(async target => {
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

    const pixel = context.getImageData(target.pixelX, target.pixelY, 1, 1).data;

    return [...pixel];
  }, input);

const openExtensionPage = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const page = await context.newPage();

  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  return page;
};

test.describe('agent frame scoping', () => {
  test('a cross-origin iframe marker stays unreadable until its origin is granted', async () => {
    test.setTimeout(120_000);

    const inner = await startFixtureServer({
      bodyHtml: `<p id="secret">${MARKER}</p>`,
      title: 'Payment frame',
    });
    const outer = await startFixtureServer({
      bodyHtml: [
        '<h1>Checkout host</h1>',
        `<iframe id="pay" src="${inner.url}/frame" style="border:0;height:${String(IFRAME_BOX.height)}px;left:${String(IFRAME_BOX.left)}px;position:fixed;top:${String(IFRAME_BOX.top)}px;width:${String(IFRAME_BOX.width)}px"></iframe>`,
      ].join(''),
      title: 'Checkout host',
    });
    const hub = await startFakeHub();
    const { context, extensionId, userDataDir } = await launchExtensionContext();

    try {
      const page = await context.newPage();
      await page.goto(outer.url);
      await page.waitForSelector('#pay');

      const frame = page.frameLocator('#pay');

      await expect(frame.locator('#secret')).toHaveText(MARKER);

      const extensionPage = await openExtensionPage(context, extensionId);
      // The session owns the tab the user is on; the transport and the D9 group are the real ones.
      const tabId = await activateTab(extensionPage, outer.url);

      expect(tabId).toBeGreaterThan(0);
      const session = await openPairedAgentSession({
        context,
        enableSwitch: () => seedLocalAgentsEnabled(extensionPage),
        extensionId,
        hub,
        sidePanel: extensionPage,
        title: 'Frame scope',
      });
      const outerOrigin = originOf(outer.url);
      const innerOrigin = originOf(inner.url);

      expect(session.tabId).toBe(tabId);

      // Nothing granted: the read itself is refused.
      const refused = await session.callTool('browser_snapshot', {}, []);

      expect(refused).toMatchObject({
        code: -32_010,
        items: [{ class: 'read', origin: outerOrigin }],
        kind: 'error',
      });

      // The tab's own origin is granted, the iframe's is not.
      const scoped = resultOf(
        await session.callTool('browser_snapshot', {}, [{ class: 'read', origin: outerOrigin }])
      );

      expect(scoped.isError).toBe(false);
      expect(scoped.text).toContain(`[origin withheld: ${innerOrigin}]`);
      expect(scoped.text).not.toContain(MARKER);
      expect(scoped.withheldFrames).toEqual([innerOrigin]);

      const found = resultOf(
        await session.callTool('browser_find', { text: MARKER }, [
          { class: 'read', origin: outerOrigin },
        ])
      );

      // The withheld frame's text never becomes a match; only the echoed query names the marker.
      expect(found.text).toContain('No matches for');
      expect(found.text).not.toContain('Path:');

      const shot = screenshotDataUrl(
        await session.callTool('browser_take_screenshot', { scale: 'css', type: 'png' }, [
          { class: 'read', origin: outerOrigin },
        ])
      );
      const insidePixel = await readPixel(extensionPage, {
        dataUrl: shot,
        pixelX: IFRAME_BOX.left + IFRAME_BOX.width / 2,
        pixelY: IFRAME_BOX.top + IFRAME_BOX.height / 2,
      });
      const outsidePixel = await readPixel(extensionPage, {
        dataUrl: shot,
        pixelX: 8,
        pixelY: 8,
      });

      expect(insidePixel.slice(0, 3)).toEqual([0, 0, 0]);
      expect(insidePixel[3]).toBe(255);
      expect(outsidePixel.slice(0, 3)).not.toEqual([0, 0, 0]);

      // Granting the frame's origin releases the content, and only then.
      const bothGrants = [
        { class: 'read', origin: outerOrigin },
        { class: 'read', origin: innerOrigin },
      ];
      const granted = resultOf(await session.callTool('browser_snapshot', {}, bothGrants));

      expect(granted.text).toContain(MARKER);
      expect(granted.withheldFrames).toEqual([]);

      const grantedFind = resultOf(
        await session.callTool('browser_find', { text: MARKER }, bothGrants)
      );

      expect(grantedFind.text).toContain(MARKER);
      expect(grantedFind.text).toContain('Path:');
    } finally {
      await context.close();
      await hub.close();
      await inner.close();
      await outer.close();
      await rm(userDataDir, { force: true, recursive: true });
    }
  });
});
