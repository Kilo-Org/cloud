/* eslint-disable import/no-nodejs-modules, vitest/no-conditional-in-test, typescript-eslint/consistent-type-definitions -- the harness writes a temp profile, and frame predicates mirror the wire protocol */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  launchExtensionContext,
  readExtensionLocalStorage,
  seedExtensionAuth,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { FAKE_HUB_ID, fakeHubMac, fakeHubNonce, startFakeHub } from './local-agents-hub-fixture';

/*
 * The local-agents flow with a real extension build and a fake loopback hub:
 * the switch turns on, the pairing navigation stores a loopback endpoint, the
 * extension completes the HMAC handshake and announces itself, a CLI controller
 * opens a session that the side panel lists, and Stop all revokes it.
 */

const PAIRING_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PAIRING_TOKEN = 'ICEiIyQlJicoKSorLC0uLw';

const rpcMessageSchema = z.object({
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

const rpcMessage = (frame: Record<string, unknown>) => {
  const message = rpcMessageSchema.safeParse(frame['message']);

  return message.success ? message.data : undefined;
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
  hub.setAllowedOrigin(`chrome-extension://${extensionId}`);
  hub.setPairing({ key: PAIRING_KEY, token: PAIRING_TOKEN });

  try {
    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Settings').click();

    const toggle = sidePanel.getByRole('switch', { name: 'Allow local agents' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

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
    const { nonceE } = auth;
    expect(auth.hubId).toBe(FAKE_HUB_ID);
    expect(auth.mac).toBe(fakeHubMac(PAIRING_KEY, `ext|${nonceH}|${nonceE}`));

    hub.send({ mac: fakeHubMac(PAIRING_KEY, `hub|${nonceE}|${nonceH}`), type: 'auth_ok' });
    hub.send({ hubVersion: '1.2.3', mode: 'loopback', protocol: [1], type: 'hub.hello' });

    await expect
      .poll(() => hub.frames.some(frame => frame['type'] === 'ext.hello'), { timeout: 10_000 })
      .toBe(true);

    const hello = helloFrameSchema.parse(hub.frames.find(frame => frame['type'] === 'ext.hello'));
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
    hub.send({
      controllerId,
      message: {
        id: 1,
        jsonrpc: '2.0',
        method: 'session.open',
        params: {
          cliVersion: '1.4.0',
          cwd,
          sessionId: 'session-e2e',
          title: sessionTitle,
        },
      },
      type: 'rpc',
    });

    await expect
      .poll(
        () =>
          hub.frames.some(
            frame =>
              frame['type'] === 'rpc' &&
              rpcMessage(frame)?.['id'] === 1 &&
              rpcMessage(frame)?.result !== undefined
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    const openResponse = hub.frames.find(
      frame => frame['type'] === 'rpc' && rpcMessage(frame)?.['id'] === 1
    );
    const sessionResult = z
      .object({ sessionHandle: z.string() })
      .parse(rpcMessage(openResponse ?? {})?.result);
    const { sessionHandle } = sessionResult;

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
