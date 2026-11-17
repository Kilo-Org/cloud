/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';

/*
 * The end-to-end proof for agent frame scoping (SPEC "Frame scoping"): a
 * cross-origin iframe holds a marker string, and an agent caller driving the
 * background runtime directly sees the marker nowhere — not in the snapshot,
 * not in find, not in the screenshot's pixels — until the iframe's origin gets
 * its own `read` grant. The runtime call is the same `kilo.tabs.browserTool`
 * message the CLI transport uses, with the agent's `authorized` pairs.
 */

const MARKER = 'KILO_FRAME_MARKER_42';
const IFRAME_BOX = { height: 200, left: 40, top: 120, width: 400 };

const agentToolResponseSchema = z.object({
  ok: z.boolean().optional(),
  permission: z.object({ items: z.array(z.record(z.string(), z.unknown())).optional() }).optional(),
  result: z
    .object({
      error: z.string().optional(),
      ok: z.boolean().optional(),
      value: z.unknown().optional(),
    })
    .optional(),
  withheldFrames: z.array(z.string()).optional(),
});

type AgentToolResponse = z.infer<typeof agentToolResponseSchema>;

/**
 * The extension API surface this spec drives inside the extension's own page.
 * Extension pages expose it on the page global (`chrome`, or `browser` on
 * Firefox), and the `evaluate` callbacks below run inside such a page.
 */
interface ExtensionPageApi {
  readonly runtime?: {
    readonly sendMessage: (message: unknown) => Promise<unknown>;
  };
  readonly tabs?: {
    readonly query: (
      query: Record<string, unknown>
    ) => Promise<readonly { readonly id?: number; readonly url?: string }[]>;
  };
}

const originOf = (url: string): string => {
  const parsed = new URL(url);

  return `${parsed.protocol}//${parsed.host}`;
};

const openExtensionPage = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const page = await context.newPage();

  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  return page;
};

const findTabId = async (extensionPage: Page, urlPrefix: string): Promise<number> => {
  const tabId = await extensionPage.evaluate(async prefix => {
    const api = (globalThis as typeof globalThis & { chrome?: ExtensionPageApi }).chrome;
    const tabs = await api?.tabs?.query({});

    return tabs?.find(tab => (tab.url ?? '').startsWith(prefix))?.id ?? -1;
  }, urlPrefix);

  return tabId;
};

const callAgentTool = async (
  extensionPage: Page,
  input: {
    readonly authorized: readonly {
      readonly class: 'act' | 'navigate' | 'read';
      readonly origin: string;
    }[];
    readonly args: Record<string, unknown>;
    readonly tabId: number;
    readonly tool: string;
  }
): Promise<AgentToolResponse> => {
  const response: unknown = await extensionPage.evaluate(
    request => {
      const api = (globalThis as typeof globalThis & { chrome?: ExtensionPageApi }).chrome;

      return api?.runtime?.sendMessage(request);
    },
    {
      agent: { authorized: [...input.authorized] },
      arguments: input.args,
      caller: { controllerId: 'controller-e2e', kind: 'agent', sessionHandle: 'session-e2e' },
      tabId: input.tabId,
      tool: input.tool,
      type: 'kilo.tabs.browserTool',
    } as const
  );
  const parsed = agentToolResponseSchema.safeParse(response);

  if (!parsed.success) {
    throw new Error(`unexpected browser tool response: ${JSON.stringify(response)}`);
  }

  return parsed.data;
};

/** A tool result's text, the only shape the snapshot and find assertions read. */
const resultTextOf = (response: AgentToolResponse): string => {
  const value = response.result?.value;

  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
};

const screenshotValueSchema = z.object({ dataUrl: z.string(), mediaType: z.string().optional() });

const screenshotValue = (response: AgentToolResponse): { dataUrl: string; mediaType: string } => {
  const parsed = screenshotValueSchema.safeParse(response.result?.value);

  if (!parsed.success) {
    throw new Error(`no screenshot in ${JSON.stringify(response)}`);
  }

  return { dataUrl: parsed.data.dataUrl, mediaType: parsed.data.mediaType ?? 'image/png' };
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
    const { context, extensionId, userDataDir } = await launchExtensionContext();

    try {
      const page = await context.newPage();

      await page.goto(outer.url);
      await page.waitForSelector('#pay');

      const frame = page.frameLocator('#pay');

      await expect(frame.locator('#secret')).toHaveText(MARKER);

      const extensionPage = await openExtensionPage(context, extensionId);
      const tabId = await findTabId(extensionPage, outer.url);
      const outerOrigin = originOf(outer.url);
      const innerOrigin = originOf(inner.url);

      expect(tabId).toBeGreaterThan(0);

      // Nothing granted: the read itself is refused.
      const refused = await callAgentTool(extensionPage, {
        args: {},
        authorized: [],
        tabId,
        tool: 'browser_snapshot',
      });

      expect(refused.permission?.items).toEqual([{ class: 'read', origin: outerOrigin }]);

      // The tab's own origin is granted, the iframe's is not.
      const scoped = await callAgentTool(extensionPage, {
        args: {},
        authorized: [{ class: 'read', origin: outerOrigin }],
        tabId,
        tool: 'browser_snapshot',
      });

      expect(scoped.result?.ok).toBe(true);
      expect(resultTextOf(scoped)).toContain(`[origin withheld: ${innerOrigin}]`);
      expect(resultTextOf(scoped)).not.toContain(MARKER);
      expect(scoped.withheldFrames).toEqual([innerOrigin]);

      const found = await callAgentTool(extensionPage, {
        args: { text: MARKER },
        authorized: [{ class: 'read', origin: outerOrigin }],
        tabId,
        tool: 'browser_find',
      });

      // The withheld frame's text never becomes a match; only the echoed query names the marker.
      expect(resultTextOf(found)).toContain('No matches for');
      expect(resultTextOf(found)).not.toContain('Path:');

      const shot = screenshotValue(
        await callAgentTool(extensionPage, {
          args: { type: 'png' },
          authorized: [{ class: 'read', origin: outerOrigin }],
          tabId,
          tool: 'browser_take_screenshot',
        })
      );
      const insidePixel = await readPixel(extensionPage, {
        dataUrl: shot.dataUrl,
        pixelX: IFRAME_BOX.left + IFRAME_BOX.width / 2,
        pixelY: IFRAME_BOX.top + IFRAME_BOX.height / 2,
      });
      const outsidePixel = await readPixel(extensionPage, {
        dataUrl: shot.dataUrl,
        pixelX: 8,
        pixelY: 8,
      });

      expect(insidePixel.slice(0, 3)).toEqual([0, 0, 0]);
      expect(insidePixel[3]).toBe(255);
      expect(outsidePixel.slice(0, 3)).not.toEqual([0, 0, 0]);

      // Granting the frame's origin releases the content, and only then.
      const granted = await callAgentTool(extensionPage, {
        args: {},
        authorized: [
          { class: 'read', origin: outerOrigin },
          { class: 'read', origin: innerOrigin },
        ],
        tabId,
        tool: 'browser_snapshot',
      });

      expect(resultTextOf(granted)).toContain(MARKER);
      expect(granted.withheldFrames).toEqual([]);

      const grantedFind = await callAgentTool(extensionPage, {
        args: { text: MARKER },
        authorized: [
          { class: 'read', origin: outerOrigin },
          { class: 'read', origin: innerOrigin },
        ],
        tabId,
        tool: 'browser_find',
      });

      expect(resultTextOf(grantedFind)).toContain(MARKER);
      expect(resultTextOf(grantedFind)).toContain('Path:');
    } finally {
      await context.close();
      await inner.close();
      await outer.close();
      await rm(userDataDir, { force: true, recursive: true });
    }
  });
});
