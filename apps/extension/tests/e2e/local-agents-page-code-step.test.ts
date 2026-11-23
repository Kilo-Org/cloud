/* eslint-disable import/no-nodejs-modules, max-lines, vitest/no-conditional-in-test -- the spec drives a real hub session against a real page and reads the page's own counter */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { launchExtensionContext, startFixtureServer } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentToolResponse } from './local-agents-fixture';

/*
 * A page registers a tool the agent may call, and calling it runs page code.
 * When that page holds a password, one-time-code or payment field, the call is a
 * sensitive step: the gate probes the document before the tool runs and answers
 * `needs_permission` with a single-use token bound to that exact call. The
 * repeat that carries the token is admitted. A page with no protected field
 * needs no approval.
 *
 * The page counts its own executions, so "the tool did not run" is the page's
 * number rather than an absence of output.
 *
 * Every admitted call here is a page tool call that the runtime answers with an
 * error, because an agent session runs without the WebMCP runtime hooks. That is
 * outside this spec: the assertions read the gate's answer, which is a protocol
 * refusal or an admitted tool result.
 */

const TOOL_NAME = 'fill_card_field';
const TOOL_TITLE = 'Fill card field';
const TOOL_DESCRIPTION = 'Writes the card number into the page form.';

const pageHtml = (withProtectedField: boolean): string => `<!doctype html>
<html>
  <head><title>Page tool fixture</title></head>
  <body>
    <h1>Page tool fixture</h1>
    ${
      withProtectedField
        ? '<label>Card number <input id="field" name="cardnumber" autocomplete="cc-number" type="text"></label>'
        : '<label>Note <input id="field" name="note" type="text"></label>'
    }
    <output id="outcome">idle</output>
    <script>
      window.__toolRuns = 0;
      const modelContext = document.modelContext;
      if (modelContext !== undefined && typeof modelContext.registerTool === 'function') {
        modelContext.registerTool({
          description: ${JSON.stringify(TOOL_DESCRIPTION)},
          execute: async ({ value }) => {
            window.__toolRuns += 1;
            document.querySelector('#field').value = String(value);
            document.querySelector('#outcome').textContent = 'tool ran ' + window.__toolRuns;
            return { runs: window.__toolRuns };
          },
          inputSchema: {
            properties: { value: { type: 'string' } },
            required: ['value'],
            type: 'object',
          },
          name: ${JSON.stringify(TOOL_NAME)},
          title: ${JSON.stringify(TOOL_TITLE)},
        });
      }
    </script>
  </body>
</html>`;

const PROTECTED_PATH = '/protected';
const PLAIN_PATH = '/plain';

const permissionItemSchema = z.object({
  class: z.string(),
  origin: z.string(),
  reason: z.string().optional(),
});

/** The tool names the page's own `document.modelContext` reports, read from the page rather than from the extension. */
const registeredToolNames = async (page: Page): Promise<readonly string[]> => {
  const value = await page.evaluate(`(async () => {
    const context = document.modelContext;
    if (context === undefined || typeof context.getTools !== 'function') { return null; }
    const tools = await context.getTools();
    return Array.isArray(tools) ? tools.map(tool => String(tool && tool.name)) : null;
  })()`);

  return z.array(z.string()).parse(value);
};

const toolRuns = async (page: Page): Promise<number> => {
  const value = await page.evaluate('window.__toolRuns === undefined ? -1 : window.__toolRuns');

  return z.number().parse(value);
};

/** One answer's shape in the run log: a refusal is a protocol error, an admitted call is a tool result. */
const callSummary = (response: LocalAgentToolResponse): string =>
  response.kind === 'result'
    ? `result isError=${String(response.isError)} text=${response.text}`
    : `error code=${String(response.code)} message=${response.message}`;

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

test('a page tool call on a page holding a protected field asks for its own approval', async () => {
  test.setTimeout(180_000);
  const fixture = await startFixtureServer({
    pathHtml: { [PLAIN_PATH]: pageHtml(false), [PROTECTED_PATH]: pageHtml(true) },
  });
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();
    const protectedUrl = `${fixture.url}${PROTECTED_PATH}`;
    const plainUrl = `${fixture.url}${PLAIN_PATH}`;

    await agentPage.goto(protectedUrl);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, protectedUrl);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Page tool step session',
    });

    const navigated = await session.callTool('browser_navigate', { url: protectedUrl }, grants);

    expect(navigated).toMatchObject({ isError: false, kind: 'result' });
    // A browser build without the page-side API cannot run this spec: the page would register nothing.
    await expect.poll(() => registeredToolNames(agentPage)).toStrictEqual([TOOL_NAME]);

    expect(await toolRuns(agentPage)).toBe(0);

    const args = { name: TOOL_NAME, params: { value: '4111' } };

    // 1. The page holds a protected field, so the call is a sensitive step: it is refused before the tool runs.
    const asked = await session.callTool('browser_webmcp_call', args, grants);

    console.log(`unapproved call: ${callSummary(asked)}`);
    expect(asked).toMatchObject({ code: -32_010, kind: 'error' });
    const askedItems = z
      .array(permissionItemSchema)
      .parse(asked.kind === 'error' ? asked.items : []);

    expect(askedItems).toStrictEqual([
      { class: 'sensitive', origin, reason: 'a page script can reach a sensitive field' },
    ]);
    const stepToken = asked.kind === 'error' ? (asked.stepToken ?? '') : '';

    expect(stepToken).not.toBe('');
    expect(await toolRuns(agentPage)).toBe(0);
    console.log(`refusal: ${JSON.stringify(askedItems)} token issued: yes`);

    // 2. The repeat that carries the approval passes the gate: no second ask, and the call runs on to the tool.
    const approved = await session.callTool('browser_webmcp_call', args, grants, [stepToken]);

    console.log(`approved call: ${callSummary(approved)}`);
    // A `result` is the gate's own answer that it admitted this call; only a refusal would be a protocol error.
    expect(approved.kind).toBe('result');

    // 3. The approval is single use: the same call with the same token is asked again.
    const spent = await session.callTool('browser_webmcp_call', args, grants, [stepToken]);

    expect(spent).toMatchObject({ code: -32_010, kind: 'error' });
    console.log(`spent token: ${callSummary(spent)}`);

    // 4. The approval is bound to that exact call: the same token does not cover different arguments.
    const otherArgs = { name: TOOL_NAME, params: { value: '5555' } };
    const reused = await session.callTool('browser_webmcp_call', otherArgs, grants, [stepToken]);

    expect(reused).toMatchObject({ code: -32_010, kind: 'error' });
    expect(
      z.array(permissionItemSchema).parse(reused.kind === 'error' ? reused.items : [])
    ).toStrictEqual([
      { class: 'sensitive', origin, reason: 'a page script can reach a sensitive field' },
    ]);
    console.log('a token bound to another call is refused');

    // 5. A page with no protected field needs no approval for the same call.
    const movedToPlain = await session.callTool('browser_navigate', { url: plainUrl }, grants);

    expect(movedToPlain).toMatchObject({ isError: false, kind: 'result' });

    const plain = await session.callTool('browser_webmcp_call', args, grants);

    console.log(`plain page call: ${callSummary(plain)}`);
    // The gate's answer is admission: a result rather than a protocol refusal. What the tool body then does over the
    // Agent socket is outside this spec, because it depends on the WebMCP runtime hooks that work item owns.
    expect(plain.kind).toBe('result');
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
