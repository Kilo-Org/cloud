/* eslint-disable import/no-nodejs-modules, max-lines, max-params, typescript-eslint/consistent-type-definitions -- wire field names and a hub-driven session shared by two specs */
import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { z } from 'zod';
import { seedExtensionAuth } from './extension-context-fixture';
import { FAKE_HUB_ID, fakeHubMac, fakeHubNonce } from './local-agents-hub-fixture';
import type { FakeHub } from './local-agents-hub-fixture';

/*
 * One paired, handshaken fake hub and one open agent session, shared by the
 * specs that must drive agents the way the CLI does: `session.open`, then
 * `session.shareActiveTab`, then `tools.call` over the socket. Nothing here
 * reaches into the background runtime directly.
 */

export const LOCAL_AGENT_PAIRING_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const LOCAL_AGENT_PAIRING_TOKEN = 'ICEiIyQlJicoKSorLC0uLw';

export const agentRpcMessageSchema = z.object({
  // `needs_permission` items, `origin_changed` origins and step tokens arrive in `data`; zod strips unlisted keys.
  error: z
    .object({ code: z.number(), data: z.unknown().optional(), message: z.string() })
    .optional(),
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

const toolResultSchema = z.object({
  _meta: z.object({ withheldFrames: z.array(z.string()).optional() }).optional(),
  content: z.array(z.record(z.string(), z.unknown())),
  isError: z.boolean().optional(),
});

export type LocalAgentToolResponse =
  | {
      readonly code: number;
      readonly items?: readonly Record<string, unknown>[] | undefined;
      readonly kind: 'error';
      readonly message: string;
      readonly stepToken?: string | undefined;
    }
  | {
      readonly image?: { readonly data: string; readonly mimeType: string } | undefined;
      readonly isError: boolean;
      readonly kind: 'result';
      readonly text: string;
      readonly withheldFrames: readonly string[];
    };

export type LocalAgentSession = {
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    authorized: readonly Record<string, unknown>[]
  ) => Promise<LocalAgentToolResponse>;
  readonly controllerId: string;
  readonly sessionHandle: string;
  readonly tabId: number;
};

const rpcMessage = (frame: Record<string, unknown>) => {
  const message = agentRpcMessageSchema.safeParse(frame['message']);

  return message.success ? message.data : undefined;
};

const rpcOf = async (hub: FakeHub, id: number) => {
  await expect
    .poll(
      () => hub.frames.some(frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['id'] === id),
      { timeout: 20_000 }
    )
    .toBe(true);

  return rpcMessage(
    hub.frames.find(frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['id'] === id) ?? {}
  );
};

/** The first RPC frame the hub received for one method, as its JSON-RPC message. */
export const rpcOfMethod = (hub: FakeHub, method: string): Record<string, unknown> | undefined => {
  const frame = hub.frames.find(candidate => {
    const message = agentRpcMessageSchema.safeParse(candidate['message']);

    return candidate['type'] === 'rpc' && message.success && message.data.method === method;
  });
  const parsed = agentRpcMessageSchema.safeParse(frame?.['message']);

  return parsed.success ? parsed.data : undefined;
};

/** One request over the paired socket, answered by the extension. */
export const sendAgentRpc = async (
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

/** Turns the switch on through its own storage, for a spec that is not about the settings UI. */
export const seedLocalAgentsEnabled = async (sidePanel: Page): Promise<void> => {
  await sidePanel.evaluate(
    'chrome.storage.local.set({ kiloLocalAgentSettings: { enabled: true } })'
  );
};

/** Turns the switch on and waits for the settings panel to report it. */
export const enableLocalAgents = async (sidePanel: Page, extensionId: string): Promise<void> => {
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
export const pairAndHandshake = async ({
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
  hub.setPairing({ key: LOCAL_AGENT_PAIRING_KEY, token: LOCAL_AGENT_PAIRING_TOKEN });

  // The CLI opens the pairing page in a tab with no opener.
  // Playwright's newPage() always records one, so create the tab through CDP.
  const cdp = await context.newCDPSession(sidePanel);
  await cdp.send('Target.createTarget', {
    newWindow: true,
    url: hub.pairingUrl(FAKE_HUB_ID, LOCAL_AGENT_PAIRING_TOKEN),
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
  expect(auth.mac).toBe(fakeHubMac(LOCAL_AGENT_PAIRING_KEY, `ext|${nonceH}|${auth.nonceE}`));

  hub.send({
    mac: fakeHubMac(LOCAL_AGENT_PAIRING_KEY, `hub|${auth.nonceE}|${nonceH}`),
    type: 'auth_ok',
  });
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
export const activateTab = async (sidePanel: Page, url: string): Promise<number> => {
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

/** Creates a tab with no opener, so `tabs.onCreated` never joins it to a session. */
export const openUnownedTab = async (sidePanel: Page, url: string): Promise<number> => {
  const tabId = await sidePanel.evaluate(
    `chrome.tabs.create({ active: false, url: ${JSON.stringify(url)} }).then(tab => tab.id ?? 0)`
  );

  return z.number().parse(tabId);
};

const textOf = (content: readonly Record<string, unknown>[]): string =>
  content.map(part => (typeof part['text'] === 'string' ? part['text'] : '')).join('\n');

const imageOf = (
  content: readonly Record<string, unknown>[]
): { readonly data: string; readonly mimeType: string } | undefined => {
  const part = content.find(entry => entry['type'] === 'image');
  const parsed = z
    .object({ data: z.string(), mimeType: z.string() })
    .safeParse(part === undefined ? undefined : { data: part['data'], mimeType: part['mimeType'] });

  return parsed.success ? parsed.data : undefined;
};

/** One RPC answer's MCP tool result, parsed: the assertions read `content`/`isError` from it. */
export const toolResultOf = (message: Record<string, unknown> | undefined) =>
  toolResultSchema.parse(message?.['result']);

/** The text content of a tool-result answer. */
export const toolTextOf = (message: Record<string, unknown> | undefined): string =>
  textOf(toolResultOf(message).content);

const responseOf = (message: Record<string, unknown>): LocalAgentToolResponse => {
  if (message['error'] !== undefined) {
    const error = z
      .object({
        code: z.number(),
        data: z.record(z.string(), z.unknown()).optional(),
        message: z.string(),
      })
      .parse(message['error']);
    const data = error.data ?? {};
    const items = z.array(z.record(z.string(), z.unknown())).safeParse(data['items']);
    const stepToken = z.string().safeParse(data['stepToken']);

    return {
      code: error.code,
      kind: 'error',
      message: error.message,
      ...(items.success ? { items: items.data } : {}),
      ...(stepToken.success ? { stepToken: stepToken.data } : {}),
    };
  }

  const result = toolResultSchema.parse(message['result']);
  const image = imageOf(result.content);

  return {
    isError: result.isError === true,
    kind: 'result',
    text: textOf(result.content),
    withheldFrames: result._meta?.withheldFrames ?? [],
    ...(image === undefined ? {} : { image }),
  };
};

/**
 * Pairs the hub, opens one CLI session and shares the active tab into its
 * group. Every later `callTool` is a `tools.call` for that session, so the
 * D9 boundary, the gate and the frame scoping all run on the real path.
 */
export const openPairedAgentSession = async ({
  beforeShare,
  context,
  enableSwitch,
  extensionId,
  hub,
  sidePanel,
  title,
}: {
  /** Runs after pairing and before the share, so a spec can activate the tab it wants. */
  beforeShare?: (() => Promise<void>) | undefined;
  /** Defaults to the settings UI; a spec about something else seeds the switch instead. */
  enableSwitch?: (() => Promise<void>) | undefined;
  context: BrowserContext;
  extensionId: string;
  hub: FakeHub;
  sidePanel: Page;
  title: string;
}): Promise<LocalAgentSession> => {
  await (enableSwitch ?? (() => enableLocalAgents(sidePanel, extensionId)))();
  await pairAndHandshake({ context, extensionId, hub, sidePanel });
  await beforeShare?.();

  const controllerId = crypto.randomUUID();

  hub.send({ controllerId, type: 'controller.connected' });

  const opened = await sendAgentRpc(hub, controllerId, 1, 'session.open', {
    cliVersion: '1.4.0',
    cwd: '/Users/igor/Projects/kilo-bridge-e2e',
    sessionId: `session-${controllerId}`,
    title,
  });
  const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);
  const shared = await sendAgentRpc(hub, controllerId, 2, 'session.shareActiveTab', {
    sessionHandle,
  });
  const tabId = z.number().parse(shared.result?.['tabId']);

  let nextId = 10;

  return {
    callTool: async (name, args, authorized) => {
      nextId += 1;

      return responseOf(
        await sendAgentRpc(hub, controllerId, nextId, 'tools.call', {
          arguments: args,
          authorized,
          name,
          sessionHandle,
        })
      );
    },
    controllerId,
    sessionHandle,
    tabId,
  };
};
