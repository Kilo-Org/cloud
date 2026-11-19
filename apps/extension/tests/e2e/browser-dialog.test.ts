/* eslint-disable import/no-nodejs-modules -- the dialog page is served by a real HTTP server */
import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { launchExtensionContext } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentToolResponse } from './local-agents-fixture';

/*
 * A click that opens a JavaScript dialog, driven the way the CLI drives the
 * extension. Chrome does not acknowledge the click's release while the dialog
 * is open, so the call has to return on the dialog itself; every other tool is
 * refused until browser_handle_dialog answers it.
 */

const DIALOG_PAGE_HTML = `<!doctype html>
<html>
  <head><title>Dialog page</title></head>
  <body>
    <button type="button" onclick="alert('Saved')">Show alert</button>
    <button type="button" onclick="document.querySelector('output').textContent = 'Hello ' + prompt('Your name?')">Ask name</button>
    <output></output>
  </body>
</html>`;

/** A call answers well inside this when it does not wait on the dialog; the old wedge took the CLI's whole timeout. */
const PROMPT_ANSWER_MS = 10_000;

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

const textOf = (answer: LocalAgentToolResponse): string =>
  answer.kind === 'result' ? answer.text : `error ${String(answer.code)} ${answer.message}`;

const refOf = (snapshotText: string, name: string): string => {
  const ref = new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`, 'u').exec(snapshotText)?.[1];

  if (ref === undefined) {
    throw new Error(`no "${name}" button in the snapshot:\n${snapshotText.slice(0, 2000)}`);
  }

  return ref;
};

/** Serves the dialog page on a free loopback port. */
const startDialogPage = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(DIALOG_PAGE_HTML);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { origin: `http://127.0.0.1:${String(port)}`, server };
};

test('a click that opens a dialog returns its modal state, and browser_handle_dialog answers it', async () => {
  test.setTimeout(120_000);
  const { origin, server } = await startDialogPage();
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({
    grantPermissions: ['downloads'],
  });

  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    // Playwright dismisses a page's dialogs itself unless the page has a listener: keep them for the extension.
    agentPage.on('dialog', () => {});
    await agentPage.goto(`${origin}/`);

    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${origin}/`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Dialog session',
    });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      textOf(await session.callTool(name, args, grants));

    await call('browser_navigate', { url: `${origin}/` });
    const snapshot = await call('browser_snapshot');

    const startedAt = performance.now();
    const clicked = await call('browser_click', {
      element: 'Show alert',
      target: refOf(snapshot, 'Show alert'),
    });

    expect(performance.now() - startedAt).toBeLessThan(PROMPT_ANSWER_MS);
    expect(clicked).toBe(
      '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by browser_handle_dialog'
    );
    expect(await call('browser_snapshot')).toContain(
      'Tool "browser_snapshot" does not handle the modal state.'
    );
    expect(await call('browser_handle_dialog', { accept: true })).toBe(
      '{"accepted":true,"type":"alert"}'
    );

    const asked = await call('browser_click', {
      element: 'Ask name',
      target: refOf(await call('browser_snapshot'), 'Ask name'),
    });

    expect(asked).toContain('["prompt" dialog with message "Your name?"]');
    await call('browser_handle_dialog', { accept: true, promptText: 'Ada' });
    expect(await call('browser_snapshot')).toContain('Hello Ada');
  } finally {
    await context.close();
    await hub.close();
    server.closeAllConnections();
    server.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
