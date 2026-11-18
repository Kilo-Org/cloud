/* eslint-disable import/no-nodejs-modules, vitest/no-conditional-in-test, typescript-eslint/consistent-type-definitions -- the harness writes a temp profile, and frame predicates mirror the wire protocol */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  launchExtensionContext,
  readExtensionLocalStorage,
  seedExtensionAuth,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import {
  FAKE_HUB_ID,
  fakeHubMac,
  fakeHubNonce,
  startFakeHub,
} from './local-agents-hub-fixture';
import type { FakeHub } from './local-agents-hub-fixture';

/*
 * The local-agents flow with a real extension build and a fake loopback hub:
 * the switch turns on, the pairing navigation stores a loopback endpoint, the
 * extension completes the HMAC handshake and announces itself, a CLI controller
 * opens a session that the side panel lists, drives a tab through the browser
 * runtime with its grants, is refused outside its group, and Stop all ends it.
 */

const PAIRING_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PAIRING_TOKEN = 'ICEiIyQlJicoKSorLC0uLw';

const rpcMessageSchema = z.object({
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

const authFrameSchema = z.object({
  hubId: z.string(),
  mac: z.string(),
  nonceE: z.string(),
  type: z.literal('auth'),
});

const helloFrameSchema = z.object({ contractSha: z.string(), protocol: z.array(z.number()) });

const toolResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  isError: z.boolean().optional(),
});

const rpcMessage = (frame: Record<string, unknown>) => {
  const message = rpcMessageSchema.safeParse(frame['message']);

  return message.success ? message.data : undefined;
};

/** The single RPC response the hub received for one request id. */
const rpcOf = async (hub: FakeHub, id: number) => {
  await expect
    .poll(
      () =>
        hub.frames.some(
          frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['id'] === id
        ),
      { timeout: 20_000 }
    )
    .toBe(true);

  return rpcMessage(
    hub.frames.find(frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['id'] === id) ?? {}
  );
};

const sendRpc = async (
  hub: FakeHub,
  controllerId: string,
  id: number,
  method: string,
  params: Record<string, unknown>
) => {
  hub.send({ controllerId, message: { id, jsonrpc: '2.0', method, params }, type: 'rpc' });

  const answered = await rpcOf(hub, id);

  if (answered === undefined) {
    throw new Error(`no answer to ${method}`);
  }

  return answered;
};

const toolText = (result: Record<string, unknown> | undefined): string => {
  const parsed = toolResultSchema.safeParse(result);

  if (!parsed.success) {
    throw new Error(`not a tool result: ${JSON.stringify(result)}`);
  }

  return parsed.data.content
    .map(part => (typeof part['text'] === 'string' ? part['text'] : ''))
    .join('\n');
};

/** Turns the switch on and waits for the settings panel to report it. */
const enableLocalAgents = async (sidePanel: Page, extensionId: string): Promise<void> => {
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  await sidePanel.getByLabel('Settings').click();

  const toggle = sidePanel.getByRole('switch', { name: 'Allow local agents' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
};

/** The CLI's pairing navigation, the HMAC handshake, and `ext.hello`. */
const pairAndHandshake = async ({
  context,
  extensionId,
  hub,
  sidePanel,
}: {
  context: BrowserContext;
  extensionId: string;
  hub: FakeHub;
  sidePanel: Page;
}): Promise<void> => {
  hub.setAllowedOrigin(`chrome-extension://${extensionId}`);
  hub.setPairing({ key: PAIRING_KEY, token: PAIRING_TOKEN });

  // The CLI opens the pairing page in a tab with no opener.
  // Playwright's newPage() always records one, so create the tab through CDP.
  const cdp = await context.newCDPSession(sidePanel);
  await cdp.send('Target.createTarget', {
    newWindow: true,
    url: hub.pairingUrl(FAKE_HUB_ID, PAIRING_TOKEN),
  });

  await expect.poll(() => hub.connected, { timeout: 15_000 }).toBe(true);
  expect(hub.origin).toBe(`chrome-extension://${extensionId}`);

  const nonceH = fakeHubNonce(0x11);
  hub.send({ nonceH, type: 'challenge' });
  await expect
    .poll(() => hub.frames.some(frame => frame['type'] === 'auth'), { timeout: 10_000 })
    .toBe(true);

  const auth = authFrameSchema.parse(hub.frames.find(frame => frame['type'] === 'auth'));
  expect(auth.hubId).toBe(FAKE_HUB_ID);
  expect(auth.mac).toBe(fakeHubMac(PAIRING_KEY, `ext|${nonceH}|${auth.nonceE}`));

  hub.send({ mac: fakeHubMac(PAIRING_KEY, `hub|${auth.nonceE}|${nonceH}`), type: 'auth_ok' });
  hub.send({ hubVersion: '1.2.3', mode: 'loopback', protocol: [1], type: 'hub.hello' });

  await expect
    .poll(() => hub.frames.some(frame => frame['type'] === 'ext.hello'), { timeout: 10_000 })
    .toBe(true);
};

/**
 * Activates the tab showing `url` and returns its browser id. The extension's
 * `session.shareActiveTab` has no tab argument, so the tab has to be the one
 * the browser reports as active.
 */
const activateTab = async (sidePanel: Page, url: string): Promise<number> => {
  const tabId = await sidePanel.evaluate(
    `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(candidate => (candidate.url || '').startsWith(${JSON.stringify(url)}));
      if (!tab || tab.id === undefined) { return 0; }
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (error) { /* headless has no OS focus */ }
      await chrome.tabs.update(tab.id, { active: true });
      return tab.id;
    })()`
  );

  return z.number().parse(tabId);
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

    const hello = helloFrameSchema.parse(
      hub.frames.find(frame => frame['type'] === 'ext.hello')
    );
    expect(hello.protocol).toStrictEqual([1]);
    expect(hello.contractSha).toHaveLength(64);

    expect(await readExtensionLocalStorage(sidePanel, 'kiloLocalAgentEndpoints')).toStrictEqual({
      endpoints: [{ hubId: FAKE_HUB_ID, key: PAIRING_KEY, ws: hub.wsUrl }],
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
    const opened = await sendRpc(hub, controllerId, 1, 'session.open', {
      cliVersion: '1.4.0',
      cwd,
      sessionId: 'session-e2e',
      title: sessionTitle,
    });
    const { sessionHandle } = z
      .object({ sessionHandle: z.string() })
      .parse(opened.result);

    await expect(sidePanel.getByText(sessionTitle)).toBeVisible();
    await expect(sidePanel.getByText(cwd)).toBeVisible();
    await expect(sidePanel.getByText('CLI 1.4.0')).toBeVisible();
    await expect(sidePanel.getByText('loopback')).toBeVisible();

    await sidePanel.getByRole('button', { name: 'Stop all' }).click();

    await expect
      .poll(
        () =>
          hub.frames.some(
            frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['method'] === 'session.revoked'
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    const revoked = hub.frames.find(
      frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['method'] === 'session.revoked'
    );
    const revokedParams = z
      .object({ reason: z.string(), sessionHandle: z.string() })
      .parse(rpcMessage(revoked ?? {})?.params);
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
    await enableLocalAgents(sidePanel, extensionId);
    await pairAndHandshake({ context, extensionId, hub, sidePanel });

    const agentPage = await context.newPage();
    await agentPage.goto(`${hub.pageUrl}?start=1`);
    const agentTabId = await activateTab(sidePanel, hub.pageUrl);

    expect(agentTabId).toBeGreaterThan(0);

    const origin = `http://127.0.0.1:${String(hub.port)}`;
    const grants = [
      { class: 'act', origin },
      { class: 'navigate', origin },
      { class: 'read', origin },
    ];
    const controllerId = crypto.randomUUID();

    hub.send({ controllerId, type: 'controller.connected' });
    const opened = await sendRpc(hub, controllerId, 1, 'session.open', {
      cliVersion: '1.4.0',
      cwd: '/Users/igor/Projects/kilo-bridge-e2e',
      sessionId: 'session-agent',
      title: 'Agent E2E session',
    });
    const { sessionHandle } = z
      .object({ sessionHandle: z.string() })
      .parse(opened.result);

    const shared = await sendRpc(hub, controllerId, 2, 'session.shareActiveTab', {
      sessionHandle,
    });
    expect(shared.result?.['tabId']).toBe(agentTabId);

    // Read the tools the contract publishes before the first call, as the CLI does.
    const tools = await sendRpc(hub, controllerId, 3, 'tools.list', {});
    expect(
      z
        .array(z.object({ name: z.string() }))
        .parse(tools.result?.['tools'])
        .map(tool => tool.name)
    ).toContain('browser_navigate');

    const navigated = await sendRpc(hub, controllerId, 4, 'tools.call', {
      arguments: { url: hub.pageUrl },
      authorized: grants,
      name: 'browser_navigate',
      sessionHandle,
    });
    expect(navigated.error).toBeUndefined();
    expect(toolResultSchema.parse(navigated.result).isError).toBeUndefined();
    await agentPage.waitForURL(hub.pageUrl);

    const snapshot = await sendRpc(hub, controllerId, 5, 'tools.call', {
      arguments: {},
      authorized: grants,
      name: 'browser_snapshot',
      sessionHandle,
    });
    expect(toolText(snapshot.result)).toContain('Bridge page');

    // A tab outside the session's group is not the agent's to act on (D9).
    const otherPage = await context.newPage();
    await otherPage.goto('about:blank');
    await activateTab(sidePanel, hub.pageUrl);

    const listed = await sendRpc(hub, controllerId, 6, 'tools.call', {
      arguments: { action: 'list' },
      authorized: grants,
      name: 'browser_tabs',
      sessionHandle,
    });
    const tabs = z
      .array(z.object({ index: z.number(), url: z.string() }))
      .parse(z.object({ tabs: z.unknown() }).parse(JSON.parse(toolText(listed.result))).tabs);
    const outside = tabs.find(tab => tab.url.includes('withheld') || tab.url === 'about:blank');

    expect(outside).toBeDefined();

    const refused = await sendRpc(hub, controllerId, 7, 'tools.call', {
      arguments: { action: 'select', index: outside?.index },
      authorized: grants,
      name: 'browser_tabs',
      sessionHandle,
    });
    const refusal = toolResultSchema.parse(refused.result);
    expect(refusal.isError).toBe(true);
    expect(toolText(refused.result)).toContain('not in the agent session');

    await sidePanel.getByRole('button', { name: 'Stop all' }).click();
    await expect
      .poll(
        () =>
          hub.frames.some(
            frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['method'] === 'session.revoked'
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    // D12: the group outlives the session, collapsed, grey and titled `Kilo · ended`.
    await expect
      .poll(
        async () =>
          sidePanel.evaluate(
            "chrome.tabGroups.query({}).then(groups => groups.map(group => ({ collapsed: group.collapsed, color: group.color, title: group.title })))"
          ),
        { timeout: 10_000 }
      )
      .toContainEqual({ collapsed: true, color: 'grey', title: 'Kilo · ended' });

    // A call after Stop all is refused as user_stopped rather than touching the page.
    const stopped = await sendRpc(hub, controllerId, 8, 'tools.call', {
      arguments: {},
      authorized: grants,
      name: 'browser_snapshot',
      sessionHandle,
    });
    expect(stopped.error?.code).toBe(-32_004);
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
