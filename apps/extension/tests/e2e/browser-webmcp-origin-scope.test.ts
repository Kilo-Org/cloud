/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { LOCAL_AGENT_ERROR_CODES } from '../../src/shared/local-agents/jsonrpc';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import type { FakeHub } from './local-agents-hub-fixture';
import {
  activateTab,
  openPairedAgentSession,
  seedLocalAgentsEnabled,
  sendAgentRpc,
} from './local-agents-fixture';
import type { LocalAgentSession, LocalAgentToolResponse } from './local-agents-fixture';

/*
 * The end-to-end proof for WebMCP descriptor origin scope, driven the way the
 * CLI drives an agent: `session.open`, `session.shareActiveTab`, then
 * `tools.call` over the paired fake hub, in a real Chrome whose page provides
 * `document.modelContext`.
 *
 * Four cases:
 * 1. A page's registration is listed, its call needs the `act` grant for the
 *    tab's origin (`-32010` without it), and with that grant the page runs.
 * 2. A descriptor that reports a different origin is absent from the list and
 *    its call answers a tool error carrying no permission items, and nothing
 *    runs. A grant is asked only for the tab's own origin.
 * 3. A descriptor that reports no origin is handled the same way.
 * 4. The tool is published with `name` and `params`, and a call that sends any
 *    other argument is answered with an error that names it.
 */

const originOf = (url: string): string => new URL(url).origin;

type WebMcpDocument = Document & {
  modelContext?: unknown;
};

/**
 * Chrome exposes `document.modelContext` under `--enable-features=WebMCP`. The
 * presence of the object is the feature, not `registerTool`: the pages below
 * that define their own object still count as having the API.
 */
const detectWebMcpApi = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const { modelContext } = document as WebMcpDocument;

    return typeof modelContext === 'object' && modelContext !== null;
  });

/** A page that registers `double` through the real WebMCP API and counts its executions. */
const registeredToolPageHtml = `
<script>
  (async () => {
    const modelContext = document.modelContext;
    if (!modelContext || typeof modelContext.registerTool !== 'function') return;
    await modelContext.registerTool({
      name: 'double',
      title: 'Double',
      description: 'Doubles a number.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async ({ value }) => {
        globalThis.__doubledTimes = (globalThis.__doubledTimes || 0) + 1;
        return { doubled: value * 2 };
      },
    });
  })();
</script>
<p>Doubling page</p>
`;

/**
 * Defines `document.modelContext` in the page's main world, which is where the
 * extension's injected discovery and execution functions run. The descriptor
 * carries `reportedOrigin`, so the fixture can present a descriptor with any
 * origin string, and `executeTool` records that it ran.
 */
const defineModelContext = (page: Page, reportedOrigin: string): Promise<void> =>
  page.evaluate(origin => {
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        executeTool: () => {
          Reflect.set(globalThis, '__toolExecuted', true);

          return Promise.resolve({ doubled: 42 });
        },
        getTools: () =>
          Promise.resolve([
            {
              description: 'Doubles a number.',
              inputSchema: {
                properties: { value: { type: 'number' } },
                required: ['value'],
                type: 'object',
              },
              name: 'double',
              origin,
              title: 'Double',
            },
          ]),
      },
    });
  }, reportedOrigin);

const readPageFlag = async (page: Page, key: string): Promise<boolean> =>
  z.boolean().parse(await page.evaluate(name => Reflect.get(globalThis, name) === true, key));

/** A page counter the page itself increments; read after the call answered, when the run already happened. */
const readPageCounter = async (page: Page, key: string): Promise<number> =>
  z.number().parse(
    await page.evaluate(name => {
      const value: unknown = Reflect.get(globalThis, name);

      return typeof value === 'number' ? value : 0;
    }, key)
  );

/** The tool result the assertions read; a protocol refusal is a test failure here. */
const resultOf = (
  response: LocalAgentToolResponse
): Extract<LocalAgentToolResponse, { kind: 'result' }> => {
  if (response.kind !== 'result') {
    throw new Error(`unexpected protocol error: ${JSON.stringify(response)}`);
  }

  return response;
};

/** The permission items a refusal carried; a response without them is a test failure here. */
const itemsOf = (response: LocalAgentToolResponse): readonly Record<string, unknown>[] => {
  if (response.kind !== 'error' || response.items === undefined) {
    throw new Error(`unexpected response without permission items: ${JSON.stringify(response)}`);
  }

  return response.items;
};

/**
 * The value the page's tool returned. The result text is the tool envelope
 * (`{ note, source, untrusted, value }`) and the page's own output travels in
 * `value` as its JSON text, so both layers are decoded here.
 */
const webMcpOutputOf = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);
  const enveloped = z.object({ value: z.unknown() }).safeParse(parsed);
  const value = enveloped.success ? enveloped.data.value : parsed;

  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
};

interface WebMcpTab {
  readonly hub: FakeHub;
  /** The origin of the page under test. */
  readonly origin: string;
  /** A second served origin (`127.0.0.1`, other port): a real, distinct browser origin no grant names. */
  readonly otherOrigin: string;
  readonly page: Page;
  readonly session: LocalAgentSession;
}

/**
 * One agent session on a page served from `127.0.0.1`, with a second fixture
 * origin serving nothing the test loads: it exists so a fixture descriptor can
 * carry a real origin of its own. Everything is torn down in `finally`, a skip
 * included.
 */
const withWebMcpTab = async (
  bodyHtml: string,
  body: (tab: WebMcpTab) => Promise<void>
): Promise<void> => {
  test.setTimeout(120_000);

  const fixture = await startFixtureServer({ bodyHtml, title: 'WebMCP origin page' });
  const other = await startFixtureServer({
    bodyHtml: '<p>Another origin.</p>',
    title: 'Other origin',
  });
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);
    test.skip(!(await detectWebMcpApi(page)), 'WebMCP API is not available in this browser');

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    const session = await openPairedAgentSession({
      beforeShare: async () => {
        // `session.shareActiveTab` has no tab argument, so the page has to be the active one.
        expect(await activateTab(extensionPage, fixture.url)).toBeGreaterThan(0);
      },
      context,
      enableSwitch: () => seedLocalAgentsEnabled(extensionPage),
      extensionId,
      hub,
      sidePanel: extensionPage,
      title: 'WebMCP origin scope',
    });

    expect(session.tabId).toBeGreaterThan(0);

    await body({
      hub,
      origin: originOf(fixture.url),
      otherOrigin: originOf(other.url),
      page,
      session,
    });
  } finally {
    await context.close();
    await hub.close();
    await other.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
};

test.describe('WebMCP descriptor origin scope', () => {
  test('a registered tool is listed, still gated on act, and runs once act is granted', async () => {
    await withWebMcpTab(registeredToolPageHtml, async ({ origin, page, session }) => {
      const readGrant = { class: 'read', origin };
      const actGrant = { class: 'act', origin };

      const listed = resultOf(await session.callTool('browser_webmcp_list', {}, [readGrant]));

      expect(listed.isError).toBe(false);
      expect(listed.text).toContain('double');

      // The descriptor's origin is the tab's own, so the existing act decision stands unchanged.
      const refused = await session.callTool(
        'browser_webmcp_call',
        { name: 'double', params: { value: 21 } },
        [readGrant]
      );

      expect(refused).toMatchObject({
        code: LOCAL_AGENT_ERROR_CODES.needsPermission,
        kind: 'error',
      });
      expect(itemsOf(refused)).toStrictEqual([{ class: 'act', origin }]);
      expect(await readPageCounter(page, '__doubledTimes')).toBe(0);

      const called = resultOf(
        await session.callTool('browser_webmcp_call', { name: 'double', params: { value: 21 } }, [
          readGrant,
          actGrant,
        ])
      );

      expect(called.isError).toBe(false);
      expect(webMcpOutputOf(called.text)).toStrictEqual({ doubled: 42 });
      expect(await readPageCounter(page, '__doubledTimes')).toBe(1);
    });
  });

  test('a descriptor reporting a different origin is absent from the list and answered with a tool error', async () => {
    await withWebMcpTab(
      '<p>Descriptor page</p>',
      async ({ origin, otherOrigin, page, session }) => {
        await defineModelContext(page, otherOrigin);

        const readGrant = { class: 'read', origin };
        const listed = resultOf(await session.callTool('browser_webmcp_list', {}, [readGrant]));

        // Absent with no trace: no tool line, and the other origin is not echoed back.
        expect(listed.isError).toBe(false);
        expect(listed.text).not.toContain('double');
        expect(listed.text).not.toContain(otherOrigin);

        // Without a grant the list itself needs the tab origin's read grant.
        const ungranted = await session.callTool('browser_webmcp_list', {}, []);

        expect(ungranted).toMatchObject({
          code: LOCAL_AGENT_ERROR_CODES.needsPermission,
          kind: 'error',
        });
        expect(itemsOf(ungranted)).toStrictEqual([{ class: 'read', origin }]);

        const refused = resultOf(
          await session.callTool('browser_webmcp_call', { name: 'double', params: { value: 21 } }, [
            readGrant,
            { class: 'act', origin },
          ])
        );

        // Only the tab's own origin is asked for: the answer is a tool error with no permission item.
        expect(refused.isError).toBe(true);
        expect(refused.text).not.toContain('doubled');
        expect(Object.hasOwn(refused, 'items')).toBe(false);
        expect(Object.hasOwn(refused, 'code')).toBe(false);
        expect(await readPageFlag(page, '__toolExecuted')).toBe(false);
      }
    );
  });

  test('a descriptor that reports no origin is absent from the list and answered with a tool error', async () => {
    await withWebMcpTab('<p>Empty origin page</p>', async ({ origin, page, session }) => {
      await defineModelContext(page, '');

      const readGrant = { class: 'read', origin };
      const listed = resultOf(await session.callTool('browser_webmcp_list', {}, [readGrant]));

      expect(listed.isError).toBe(false);
      expect(listed.text).not.toContain('double');

      const refused = resultOf(
        await session.callTool('browser_webmcp_call', { name: 'double', params: { value: 21 } }, [
          readGrant,
          { class: 'act', origin },
        ])
      );

      // A descriptor with no origin leaves no grant to ask for: the answer is the tool's own error.
      expect(refused.isError).toBe(true);
      expect(refused.text).not.toContain('doubled');
      expect(Object.hasOwn(refused, 'items')).toBe(false);
      expect(Object.hasOwn(refused, 'code')).toBe(false);
      expect(await readPageFlag(page, '__toolExecuted')).toBe(false);
    });
  });

  test('the tool is published with name and params, and any other argument is named in the error', async () => {
    await withWebMcpTab(registeredToolPageHtml, async ({ hub, origin, page, session }) => {
      const grants = [
        { class: 'read', origin },
        { class: 'act', origin },
      ];

      // The listing a model reads, over the paired socket: only `name` and `params` are offered.
      const listed = await sendAgentRpc(hub, session.controllerId, 9001, 'tools.list', {});
      const listing = z
        .object({
          tools: z.array(
            z.object({ inputSchema: z.record(z.string(), z.unknown()), name: z.string() })
          ),
        })
        .parse(listed.result);
      const published = z
        .object({ inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) })
        .parse(listing.tools.find(tool => tool.name === 'browser_webmcp_call'));

      expect(Object.hasOwn(published.inputSchema.properties, 'frame')).toBe(false);
      expect(Object.keys(published.inputSchema.properties).toSorted()).toStrictEqual([
        'name',
        'params',
      ]);

      const refused = resultOf(
        await session.callTool(
          'browser_webmcp_call',
          { frame: '0', name: 'double', params: { value: 1 } },
          grants
        )
      );

      // The error names the argument and carries no permission item.
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('frame');
      expect(Object.hasOwn(refused, 'items')).toBe(false);
      expect(await readPageCounter(page, '__doubledTimes')).toBe(0);

      // The same call with only the published arguments still runs the page's tool.
      const called = resultOf(
        await session.callTool(
          'browser_webmcp_call',
          { name: 'double', params: { value: 1 } },
          grants
        )
      );

      expect(called.isError).toBe(false);
      expect(webMcpOutputOf(called.text)).toStrictEqual({ doubled: 2 });
      expect(await readPageCounter(page, '__doubledTimes')).toBe(1);
    });
  });
});
