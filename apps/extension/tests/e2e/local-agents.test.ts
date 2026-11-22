/* eslint-disable import/no-nodejs-modules, max-lines, vitest/no-conditional-in-test, typescript-eslint/consistent-type-definitions -- the harness writes a temp profile, and frame predicates mirror the wire protocol */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { launchExtensionContext, readExtensionLocalStorage } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { FAKE_HUB_ID, startFakeHub } from './local-agents-hub-fixture';
import { LOCAL_AGENT_ERROR_CODES } from '../../src/shared/local-agents/jsonrpc';
import {
  LOCAL_AGENT_PAIRING_KEY,
  activateTab,
  enableLocalAgents,
  openPairedAgentSession,
  openUnownedTab,
  pairAndHandshake,
  rpcOfMethod,
  sendAgentRpc,
  toolResultOf,
  toolTextOf,
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

/** One line of the list Playwright MCP prints: `- 0: (current) [Title](url)`. */
const tabLinePattern = /^- (\d+): (?:\(current\) )?\[(?<title>.*)\]\((?<url>.*)\)$/u;

/**
 * The tabs an agent's `browser_tabs list` reported, as index/selected/url rows.
 * A CLI agent reads the text shape Playwright MCP prints (one `- N: …` line per
 * tab); the panel's JSON object is not what the bridge hands the model.
 */
const parseTabRows = (text: string) =>
  text.split('\n').flatMap(line => {
    const match = tabLinePattern.exec(line.trim());

    return match?.groups === undefined
      ? []
      : [
          {
            index: Number(match[1]),
            // The (current) marker is the only select state the text carries.
            selected: match[0].includes('(current)'),
            url: match.groups['url'] ?? '',
          },
        ];
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

  return { tabs: parseTabRows(listed.text) };
};

/** Every open tab with its url and focus state, read from the extension page. */
const listOpenTabs = (sidePanel: Page): Promise<unknown> =>
  sidePanel.evaluate(
    "chrome.tabs.query({}).then(tabs => tabs.map(tab => ({ active: tab.active === true, id: tab.id, url: tab.url || '' })))"
  );

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

    // The stamp is when the hub was last reachable; it lets a dead hub's endpoint be removed later.
    expect(await readExtensionLocalStorage(sidePanel, 'kiloLocalAgentEndpoints')).toStrictEqual({
      endpoints: [
        {
          hubId: FAKE_HUB_ID,
          key: LOCAL_AGENT_PAIRING_KEY,
          lastConnectedAt: expect.any(Number),
          ws: hub.wsUrl,
        },
      ],
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
    // The list reports only the session's own tab: the user's tabs are neither listed nor counted.
    expect(before.tabs.find(row => row.url.includes('other=1'))).toBeUndefined();
    expect(before.tabs.map(row => row.index)).toStrictEqual(
      before.tabs.map((_row, position) => position)
    );
    expect(before.tabs.some(row => row.url.includes(hub.pageUrl))).toBe(true);

    // The position the outside tab holds among the browser's inspectable tabs is past the agent's list.
    const inspectableTabIds = z
      .array(z.number())
      .parse(
        await sidePanel.evaluate(
          "chrome.tabs.query({}).then(tabs => tabs.filter(tab => /^https?:/.test(tab.url || '')).map(tab => tab.id))"
        )
      );
    const outsideIndex = inspectableTabIds.indexOf(unownedTabId);
    expect(outsideIndex).toBeGreaterThanOrEqual(before.tabs.length);

    const refused = await session.callTool(
      'browser_tabs',
      { action: 'select', index: outsideIndex },
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

test('a session gets its own tab from the first navigate, without touching the user\u2019s', async () => {
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
      title: 'Own tab session',
    });
    const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);
    const origin = `http://127.0.0.1:${String(hub.port)}`;

    // Nothing is shared: the agent opens its own tab instead of taking the one the user is on.
    const before = z
      .array(z.object({ active: z.boolean(), id: z.number(), url: z.string() }))
      .parse(await listOpenTabs(sidePanel));

    const navigated = await sendAgentRpc(hub, controllerId, 2, 'tools.call', {
      arguments: { url: hub.pageUrl },
      authorized: [
        { class: 'navigate', origin },
        { class: 'read', origin },
      ],
      name: 'browser_navigate',
      sessionHandle,
    });

    expect(navigated.error).toBeUndefined();
    expect(toolResultOf(navigated).isError).toBeUndefined();

    const snapshot = await sendAgentRpc(hub, controllerId, 3, 'tools.call', {
      arguments: {},
      authorized: [{ class: 'read', origin }],
      name: 'browser_snapshot',
      sessionHandle,
    });

    expect(toolTextOf(snapshot)).toContain('Bridge page');

    const after = z
      .array(z.object({ active: z.boolean(), id: z.number(), url: z.string() }))
      .parse(await listOpenTabs(sidePanel));
    const created = after.filter(tab => !before.some(previous => previous.id === tab.id));

    // Exactly one tab, on the page the agent navigated to, and it never took focus.
    expect(created).toHaveLength(1);
    expect(created[0]?.url).toBe(hub.pageUrl);
    expect(created[0]?.active).toBe(false);
    // The user's tab is still the active one.
    expect(after.find(tab => tab.active)?.id).toBe(before.find(tab => tab.active)?.id);

    // The new tab lives in the session's titled group (D9/D12).
    await expect
      .poll(
        () =>
          sidePanel.evaluate(
            'chrome.tabGroups.query({}).then(groups => groups.map(group => ({ title: group.title, collapsed: group.collapsed })))'
          ),
        { timeout: 10_000 }
      )
      .toContainEqual({ collapsed: false, title: 'Kilo · Own tab session' });

    const groupId = z
      .number()
      .parse(
        await sidePanel.evaluate(
          "chrome.tabGroups.query({}).then(groups => groups.find(group => group.title === 'Kilo · Own tab session')?.id ?? 0)"
        )
      );

    expect(groupId).toBeGreaterThan(0);

    // Stop all ends the session, and the group ends with it: read back through the API the UI would use.
    await sidePanel.getByRole('button', { name: 'Stop all' }).click();
    await expect.poll(() => rpcOfMethod(hub, 'session.revoked'), { timeout: 10_000 }).toBeDefined();
    await expect
      .poll(
        () =>
          sidePanel.evaluate(
            `chrome.tabGroups.get(${String(groupId)}).then(group => ({ collapsed: group.collapsed, color: group.color, title: group.title }))`
          ),
        { timeout: 10_000 }
      )
      .toStrictEqual({ collapsed: true, color: 'grey', title: 'Kilo · ended' });
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a browser_tabs new reports the origin its opened tab loaded', async () => {
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
    const userPage = await context.newPage();

    await userPage.goto(hub.pageUrl);

    // A shared tab, so the step runs as `browser_tabs` on a session that already holds one.
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, hub.pageUrl);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Tabs redirect session',
    });
    const origin = `http://127.0.0.1:${String(hub.port)}`;
    const grants = grant(origin);

    // The destination answers with a redirect to a second loopback server, and the call reports where the tab loaded.
    const landing = await startFakeHub();
    const landingOrigin = `http://127.0.0.1:${String(landing.port)}`;

    try {
      const answered = await sendAgentRpc(hub, session.controllerId, 900, 'tools.call', {
        arguments: { action: 'new', url: hub.redirectUrl(landing.pageUrl) },
        authorized: grants,
        name: 'browser_tabs',
        sessionHandle: session.sessionHandle,
      });

      // The answer names both origins: the destination the call asked for and the origin the tab loaded.
      expect(answered.error).toMatchObject({
        code: LOCAL_AGENT_ERROR_CODES.originChanged,
        data: { from: origin, to: landingOrigin },
      });

      // The tab the call opened is on the redirect's target, so the answer describes the real load.
      const listed = await listTabs(session.callTool, grants);
      expect(listed.tabs.some(row => row.url.startsWith(landingOrigin))).toBe(true);
    } finally {
      await landing.close();
    }
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('the first navigate loads a single-use destination once', async () => {
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
      sessionId: 'session-once',
      title: 'Single-use session',
    });
    const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);
    const origin = `http://127.0.0.1:${String(hub.port)}`;

    expect(hub.oncePageHits()).toBe(0);

    const navigated = await sendAgentRpc(hub, controllerId, 2, 'tools.call', {
      arguments: { url: hub.onceUrl },
      authorized: [
        { class: 'navigate', origin },
        { class: 'read', origin },
      ],
      name: 'browser_navigate',
      sessionHandle,
    });

    expect(navigated.error).toBeUndefined();
    expect(toolResultOf(navigated).isError).toBeUndefined();
    // The tool reports the page it settled on, not the request it made.
    expect(toolTextOf(navigated)).toContain(hub.onceUrl);

    // The tab was opened at the destination, and the navigate did not request the same URL again.
    await expect.poll(() => hub.oncePageHits(), { timeout: 10_000 }).toBe(1);

    const snapshot = await sendAgentRpc(hub, controllerId, 3, 'tools.call', {
      arguments: {},
      authorized: [{ class: 'read', origin }],
      name: 'browser_snapshot',
      sessionHandle,
    });

    expect(toolTextOf(snapshot)).toContain('Bridge page');
    expect(hub.oncePageHits()).toBe(1);
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a session refuses a first navigate to a URL no grant can name', async () => {
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
      sessionId: 'session-off-grant',
      title: 'Off-grant session',
    });
    const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);
    const origin = `http://127.0.0.1:${String(hub.port)}`;

    const before = z
      .array(z.object({ id: z.number(), url: z.string() }))
      .parse(await listOpenTabs(sidePanel));

    const refused = await sendAgentRpc(hub, controllerId, 2, 'tools.call', {
      arguments: { url: 'data:text/html,<h1>off-grant</h1>' },
      authorized: [{ class: 'navigate', origin }],
      name: 'browser_navigate',
      sessionHandle,
    });

    // Fail closed: a URL the debugger could never attach to is refused as blocked, before any tab exists.
    expect(refused.error).toMatchObject({ code: -32_011 });

    const after = z
      .array(z.object({ id: z.number(), url: z.string() }))
      .parse(await listOpenTabs(sidePanel));

    expect(after.filter(tab => !before.some(previous => previous.id === tab.id))).toHaveLength(0);
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
