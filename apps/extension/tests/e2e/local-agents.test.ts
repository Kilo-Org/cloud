/* eslint-disable import/no-nodejs-modules, max-lines, vitest/no-conditional-in-test, typescript-eslint/consistent-type-definitions -- the harness writes a temp profile, and frame predicates mirror the wire protocol */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { launchExtensionContext, readExtensionLocalStorage } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { FAKE_HUB_ID, startFakeHub } from './local-agents-hub-fixture';
import {
  LOCAL_AGENT_PAIRING_KEY,
  activateTab,
  enableLocalAgents,
  openPairedAgentSession,
  openUnownedTab,
  pairAndHandshake,
  rpcOfMethod,
  sendAgentRpc,
} from './local-agents-fixture';

/*
 * The local-agents flow with a real extension build and a fake loopback hub:
 * the switch turns on, the pairing navigation stores a loopback endpoint, the
 * extension completes the HMAC handshake and announces itself, a CLI controller
 * opens a session that the side panel lists, drives a tab through the browser
 * runtime with its grants, is refused outside its group, and Stop all ends it.
 */

const helloFrameSchema = z.object({ contractSha: z.string(), protocol: z.array(z.number()) });

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

const tabRowsSchema = z.object({
  tabs: z.array(z.object({ index: z.number(), selected: z.boolean(), url: z.string() })),
});

const listTabs = async (
  callTool: (
    name: string,
    args: Record<string, unknown>,
    authorized: readonly Record<string, unknown>[]
  ) => Promise<{ kind: string; text?: string }>,
  authorized: readonly Record<string, unknown>[]
) => {
  const listed = await callTool('browser_tabs', { action: 'list' }, authorized);

  if (listed.text === undefined) {
    throw new Error(`browser_tabs list failed: ${JSON.stringify(listed)}`);
  }

  return tabRowsSchema.parse(JSON.parse(listed.text));
};

test('local agents pair over loopback, list the session, and Stop all revokes it', async () => {
  test.setTimeout(60_000);
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  await mockKiloApi(context, {});
  // A real user answers the optional-permission prompt; automation cannot.
  // The page grants it the way an accepted prompt would, keeping the flow deterministic.
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();

    await enableLocalAgents(sidePanel, extensionId);
    await pairAndHandshake({ context, extensionId, hub, sidePanel });

    const hello = helloFrameSchema.parse(hub.frames.find(frame => frame['type'] === 'ext.hello'));
    expect(hello.protocol).toStrictEqual([1]);
    expect(hello.contractSha).toHaveLength(64);

    expect(await readExtensionLocalStorage(sidePanel, 'kiloLocalAgentEndpoints')).toStrictEqual({
      endpoints: [{ hubId: FAKE_HUB_ID, key: LOCAL_AGENT_PAIRING_KEY, ws: hub.wsUrl }],
    });
    await expect
      .poll(async () =>
        z
          .boolean()
          .parse(
            await sidePanel.evaluate(
              "new Promise(resolve => chrome.tabs.query({}, tabs => resolve(tabs.some(tab => (tab.url || '').includes('/__kilo_browser_pair/')))))"
            )
          )
      )
      .toBe(false);

    const controllerId = crypto.randomUUID();
    const sessionTitle = 'Local agent E2E session';
    const cwd = '/Users/igor/Projects/kilo-bridge-e2e';

    hub.send({ controllerId, type: 'controller.connected' });
    const opened = await sendAgentRpc(hub, controllerId, 1, 'session.open', {
      cliVersion: '1.4.0',
      cwd,
      sessionId: 'session-e2e',
      title: sessionTitle,
    });
    const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);

    await expect(sidePanel.getByText(sessionTitle)).toBeVisible();
    await expect(sidePanel.getByText(cwd)).toBeVisible();
    await expect(sidePanel.getByText('CLI 1.4.0')).toBeVisible();
    await expect(sidePanel.getByText('loopback')).toBeVisible();

    await sidePanel.getByRole('button', { name: 'Stop all' }).click();

    await expect.poll(() => rpcOfMethod(hub, 'session.revoked'), { timeout: 10_000 }).toBeDefined();

    const revokedParams = z
      .object({ reason: z.string(), sessionHandle: z.string() })
      .parse(rpcOfMethod(hub, 'session.revoked')?.['params']);
    expect(revokedParams).toStrictEqual({ reason: 'user_stop', sessionHandle });
    await expect(sidePanel.getByText(sessionTitle)).toHaveCount(0);
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('an agent session drives its tab through the runtime and Stop all ends it', async () => {
  test.setTimeout(90_000);
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

    await agentPage.goto(`${hub.pageUrl}?start=1`);

    let agentTabId = 0;

    // One CLI session owns the tab the user is looking at (D9).
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        agentTabId = await activateTab(sidePanel, hub.pageUrl);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Agent E2E session',
    });
    expect(agentTabId).toBeGreaterThan(0);
    expect(session.tabId).toBe(agentTabId);

    const origin = `http://127.0.0.1:${String(hub.port)}`;
    const grants = grant(origin);

    // Read the tools the contract publishes before the first call, as the CLI does.
    const tools = await sendAgentRpc(hub, session.controllerId, 3, 'tools.list', {});
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(tools.result?.['tools'])
        .map(tool => tool.name)
    ).toContain('browser_navigate');

    const navigated = await session.callTool('browser_navigate', { url: hub.pageUrl }, grants);
    expect(navigated).toMatchObject({ isError: false, kind: 'result' });
    await agentPage.waitForURL(hub.pageUrl);

    const snapshot = await session.callTool('browser_snapshot', {}, grants);
    expect(snapshot.kind === 'result' && snapshot.text).toContain('Bridge page');

    // A tab nobody opened from the session's tab is outside its group (D9).
    const unownedTabId = await openUnownedTab(sidePanel, `${hub.pageUrl}?other=1`);
    expect(unownedTabId).toBeGreaterThan(0);

    const before = await listTabs(session.callTool, grants);
    const outside = before.tabs.find(row => row.url.includes('other=1'));
    expect(outside).toBeDefined();
    expect(outside?.selected).toBe(false);

    const refused = await session.callTool(
      'browser_tabs',
      { action: 'select', index: outside?.index },
      grants
    );
    // A D9 refusal is `blocked` (-32011) for the CLI, not a tool error.
    expect(refused).toMatchObject({ code: -32_011, kind: 'error' });
    expect(refused.kind === 'error' && refused.message).toContain('not in the agent session');

    // A tab opened *from* the session's tab joins the group, so the refusal above is not vacuous.
    await agentPage.evaluate("window.open('/page?opened=1', '_blank')");
    await expect
      .poll(
        async () => {
          const listed = await listTabs(session.callTool, grants);

          return listed.tabs.some(row => row.url.includes('opened=1'));
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    const listedAfterOpen = await listTabs(session.callTool, grants);
    const joined = listedAfterOpen.tabs.find(row => row.url.includes('opened=1'));
    const selected = await session.callTool(
      'browser_tabs',
      { action: 'select', index: joined?.index },
      grants
    );
    expect(selected).toMatchObject({ isError: false, kind: 'result' });

    await sidePanel.getByRole('button', { name: 'Stop all' }).click();
    await expect.poll(() => rpcOfMethod(hub, 'session.revoked'), { timeout: 10_000 }).toBeDefined();

    // D12: the group outlives the session, collapsed, grey and titled `Kilo · ended`.
    await expect
      .poll(
        () =>
          sidePanel.evaluate(
            'chrome.tabGroups.query({}).then(groups => groups.map(group => ({ collapsed: group.collapsed, color: group.color, title: group.title })))'
          ),
        { timeout: 10_000 }
      )
      .toContainEqual({ collapsed: true, color: 'grey', title: 'Kilo · ended' });

    // A call after Stop all is refused as user_stopped rather than touching the page.
    const stopped = await session.callTool('browser_snapshot', {}, grants);
    expect(stopped).toMatchObject({ code: -32_004, kind: 'error' });
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a session is refused before a tab is shared into its group', async () => {
  test.setTimeout(60_000);
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();

    await enableLocalAgents(sidePanel, extensionId);
    await pairAndHandshake({ context, extensionId, hub, sidePanel });

    const controllerId = crypto.randomUUID();
    hub.send({ controllerId, type: 'controller.connected' });
    const opened = await sendAgentRpc(hub, controllerId, 1, 'session.open', {
      cliVersion: '1.4.0',
      cwd: '/Users/igor/Projects/kilo-bridge-e2e',
      sessionId: 'session-e2e',
      title: 'No tab yet',
    });
    const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);

    // Nothing shared: there is no group to reach, so the call is refused rather than run on a guess.
    const answered = await sendAgentRpc(hub, controllerId, 2, 'tools.call', {
      arguments: {},
      authorized: [],
      name: 'browser_snapshot',
      sessionHandle,
    });

    expect(z.object({ code: z.number() }).parse(answered.error).code).toBe(-32_011);
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
