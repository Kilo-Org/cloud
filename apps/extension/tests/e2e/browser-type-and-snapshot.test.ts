/* eslint-disable import/no-nodejs-modules -- the harness removes its temp profile */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentSession } from './local-agents-fixture';

/*
 * A CLI session drives a real form through the extension runtime: its
 * snapshot nests a line only under the lines printed above it, and
 * `browser_type` replaces what a field holds, as Playwright's `fill` does,
 * while `slowly` types at the caret like `pressSequentially`.
 */

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

const snapshotLine = (snapshot: string, fragment: string): string => {
  const line = snapshot.split('\n').find(candidate => candidate.includes(fragment));

  if (line === undefined) {
    throw new Error(`no "${fragment}" line in the snapshot:\n${snapshot.slice(0, 2000)}`);
  }

  return line;
};

const indentOf = (snapshot: string, fragment: string): number =>
  snapshotLine(snapshot, fragment).search(/\S/u);

const refOf = (snapshot: string, fragment: string): string => {
  const ref = /\[ref=(e\d+)\]/u.exec(snapshotLine(snapshot, fragment))?.[1];

  if (ref === undefined) {
    throw new Error(`the "${fragment}" line carries no ref`);
  }

  return ref;
};

const callAgentTool = async (
  agent: {
    readonly grants: readonly Record<string, unknown>[];
    readonly session: LocalAgentSession;
  },
  name: string,
  args: Record<string, unknown>
): Promise<string> => {
  const answer = await agent.session.callTool(name, args, agent.grants);

  if (answer.kind !== 'result' || answer.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(answer)}`);
  }

  return answer.text;
};

test('an agent snapshot nests by printed lines and browser_type replaces field text', async () => {
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

    await agentPage.goto(hub.formUrl);

    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, hub.formUrl);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Form typing session',
    });
    const agent = { grants: grant(`http://127.0.0.1:${String(hub.port)}`), session };
    const call = (name: string, args: Record<string, unknown>) => callAgentTool(agent, name, args);

    const snapshot = await call('browser_snapshot', {});

    expect(indentOf(snapshot, 'textbox "Email"')).toBe(indentOf(snapshot, 'heading "Contact"'));
    expect(indentOf(snapshot, 'text: idle')).toBe(indentOf(snapshot, 'button "Submit"'));

    await agentPage.evaluate(`
      window.__kiloInputEvents = [];
      for (const id of ['email', 'notes', 'bio']) {
        document.getElementById(id).addEventListener('input', () => window.__kiloInputEvents.push(id));
      }
    `);

    const fields = [
      { fragment: 'textbox "Email"', read: () => agentPage.locator('#email').inputValue() },
      { fragment: 'textbox "Notes"', read: () => agentPage.locator('#notes').inputValue() },
      { fragment: 'textbox "Bio"', read: () => agentPage.locator('#bio').textContent() },
    ];

    for (const field of fields) {
      const target = refOf(snapshot, field.fragment);

      for (const text of ['c2', 'c6', 'c10']) {
        // eslint-disable-next-line no-await-in-loop -- each call types into what the previous call left
        await call('browser_type', { target, text });
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect.poll(field.read).toBe(text);
      }
    }

    expect(await agentPage.evaluate('window.__kiloInputEvents')).toStrictEqual([
      'email',
      'email',
      'email',
      'notes',
      'notes',
      'notes',
      'bio',
      'bio',
      'bio',
    ]);

    const email = refOf(snapshot, 'textbox "Email"');

    await agentPage.locator('#notes').focus();
    await call('browser_type', { slowly: true, target: email, text: 'x' });
    await expect.poll(() => agentPage.locator('#email').inputValue()).toBe('xc10');
    await call('browser_type', { slowly: true, target: email, text: 'yz' });
    await expect.poll(() => agentPage.locator('#email').inputValue()).toBe('xyzc10');
  } finally {
    await context.close();
    await hub.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
