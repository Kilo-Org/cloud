/* eslint-disable import/max-dependencies, import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec reads a real downloads directory and drives a real hub session */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hashBrowserToolArguments } from '../../src/shared/browser-agent-checks';
import { LOCAL_AGENT_ERROR_CODES } from '../../src/shared/local-agents/jsonrpc';
import {
  CARD_PAGE_PATH,
  DOWNLOAD_BODY,
  DOWNLOAD_FILENAME,
  DOWNLOAD_PATH,
  DROP_PAGE_PATH,
  ONCE_DOWNLOAD_PATH,
  SECOND_DOWNLOAD_FILENAME,
  startDownloadFixture,
  TWO_DOWNLOADS_PAGE_PATH,
  USER_DOWNLOAD_FILENAME,
  USER_DOWNLOAD_PATH,
  USER_PAGE_PATH,
} from './download-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import {
  activateTab,
  enableLocalAgents,
  openPairedAgentSession,
  pairAndHandshake,
  sendAgentRpc,
} from './local-agents-fixture';
import type { LocalAgentSession, LocalAgentToolResponse } from './local-agents-fixture';
import {
  downloadFiles,
  launchRealDownloadBrowser,
  readDownloadedFile,
  tempDownloadFiles,
} from './real-download-launch';

/*
 * SPEC "Permission flow" step 6 and the wire contract §3: an agent `act` call
 * that starts a download refuses it and answers `needs_permission` with
 * `afterAction: true`; the identical call re-sent with that step token runs once
 * with the guard off. The downloads directory is a real directory Chrome writes
 * into, so "the file did not land" is a directory read rather than an event
 * count.
 *
 * Every spec here runs on the real launch: Chrome started as a child process,
 * downloading into a folder its profile names, with Playwright attached over
 * CDP. Playwright's own `launchPersistentContext` installs the DevTools download
 * delegate, which writes under a GUID and never dispatches
 * `chrome.downloads.onDeterminingFilename` — the event the guard is built on.
 * The probe in download-launch-probe.test.ts pins that difference.
 *
 * A download in flight writes a dot-prefixed temp file in the folder
 * (`.org.chromium.Chromium.XXXXXX`). A folder read during a call ignores it —
 * it is not a finished file — but a refusal leaves none behind, so the refusal
 * specs assert the temp files are gone too.
 */

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

/**
 * Every open tab's id, read from the extension page. `browser_tabs list` is not
 * the surface for "no second tab": it lists only the session's inspectable
 * tabs, and the tab a guarded `new` opens stays blank because its navigation
 * was refused, so a correct list is empty there. A failed answer throws instead
 * of counting as zero, which would make a `0 === 0` comparison prove nothing.
 */
const openTabIds = (sidePanel: Page): Promise<number[]> =>
  sidePanel.evaluate(
    "chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id)).then(ids => { if (ids.length === 0) { throw new Error('the browser reported no tabs'); } return ids; })"
  );

const permissionItemSchema = z.object({
  class: z.string(),
  origin: z.string(),
  reason: z.string().optional(),
});

/** The control's ref from a fresh snapshot of the fixture page: its accessible name is how the model names it. */
const controlRef = async (
  session: LocalAgentSession,
  grants: readonly Record<string, unknown>[],
  pattern: RegExp
) => {
  const snapshot = await session.callTool('browser_snapshot', {}, grants);

  if (snapshot.kind !== 'result') {
    throw new Error(`browser_snapshot failed: ${JSON.stringify(snapshot)}`);
  }

  const ref = pattern.exec(snapshot.text)?.[1];

  if (ref === undefined) {
    throw new Error(`no matching control in snapshot:\n${snapshot.text}`);
  }

  return ref;
};

const downloadRef = (session: LocalAgentSession, grants: readonly Record<string, unknown>[]) =>
  controlRef(session, grants, /link "Download report" \[ref=(e\d+)\]/u);

/** The approved file is the only finished file, and no download is still writing one. */
const expectOnlyFinishedFile = async (downloadsPath: string, filename: string): Promise<void> => {
  await expect
    .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
    .toStrictEqual([filename]);
  await expect.poll(() => tempDownloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
};

/** A refusal leaves the folder as it was: no finished file, and no temp file still growing. */
const expectNothingSaved = async (downloadsPath: string): Promise<void> => {
  await expect.poll(() => downloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
  await expect.poll(() => tempDownloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
};

/*
 * Makes the drop page show what a drop handed it, on the page itself.
 *
 * The fixture's own listener reports the names to `/drop-received` and keeps
 * nothing, so the page's visible state never changes on its own. This second
 * listener renders that same `dataTransfer` into a `#drop-record` paragraph —
 * the names and byte counts the browser really described — and keeps the files
 * and their read results on `window` for the assertions that check bytes, not
 * names. The screenshot of the page is therefore a picture of the page's own
 * record, taken only after that record was asserted.
 *
 * Installed after a navigation: a new document drops every listener with it.
 */
const recordDropsOnPage = async (page: Page): Promise<void> => {
  await page.evaluate(`
    const zone = document.querySelector('#zone');
    const record = document.createElement('p');
    record.id = 'drop-record';
    record.textContent = 'Drop record: nothing received yet';
    zone.after(record);
    zone.addEventListener('drop', event => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      window.__droppedFiles = files.map(file => ({ name: file.name, size: file.size }));
      window.__droppedReads = Promise.all(
        files.map(file => file.text().then(() => 'readable', error => String(error)))
      );
      record.textContent =
        files.length === 0
          ? 'Drop record: nothing received'
          : 'Drop record: ' + files.map(file => file.name + ' (' + file.size + ' bytes)').join(', ');
    });
  `);
};

/**
 * The panel's own local-agents settings section, showing the paired CLI's
 * entry. The dialog is the one `enableLocalAgents` opened, and the section
 * re-reads storage on every change, so the agent appears once the session
 * exists; `scrollIntoViewIfNeeded` brings the row on screen, because the dialog
 * scrolls internally and a full-page capture cannot reach past a fixed overlay.
 */
const screenshotConnectedAgent = async (sidePanel: Page, path: string): Promise<void> => {
  await sidePanel.bringToFront();
  const dialog = sidePanel.getByRole('dialog', { name: 'Settings panel' });
  await expect(dialog).toBeVisible();
  const connected = dialog.getByText('Connected agents');
  await expect(connected).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('loopback', { exact: true })).toBeVisible();
  await connected.scrollIntoViewIfNeeded();
  await sidePanel.screenshot({ fullPage: true, path });
};

test('a guarded click cancels the download, and the approved retry keeps it', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Download E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}/page` },
      grants
    );
    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    const target = await downloadRef(session, grants);

    // 1. Guarded: the click runs once, the download it starts is refused, and the folder stays empty.
    const guarded = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants
    );

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    expect(guarded.kind === 'error' ? guarded.stepToken : undefined).toEqual(expect.any(String));
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);
    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'downloading a file' }]);
    expect(fixture.hits()).toBeGreaterThan(0);

    // The browser created the item and the guard stopped it before it settled, so nothing is in the folder, and
    // Nothing is still writing one. The request reaching the fixture is the proof the click ran the download.
    await expectNothingSaved(downloadsPath);

    // 2. The human approved: the identical call with the token runs with the guard off once.
    const approved = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );
    expect(approved).toMatchObject({ isError: false, kind: 'result' });

    // The page named the file, so Chrome wrote it under that name in the folder it was given.
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);
    expect(await readDownloadedFile(downloadsPath, DOWNLOAD_FILENAME)).toBe(DOWNLOAD_BODY);

    // 3. The token was burned: the same call again is guarded, so the guard is not left off.
    const reguarded = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );
    expect(reguarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    // The approved file is still the only one, unchanged.
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 10_000 })
      .toStrictEqual([DOWNLOAD_FILENAME]);
    expect(await readDownloadedFile(downloadsPath, DOWNLOAD_FILENAME)).toBe(DOWNLOAD_BODY);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('a guarded click whose attachment fails saves nothing and claims no file', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Broken download E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}/page` },
      grants
    );
    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    const target = await controlRef(session, grants, /link "Broken report" \[ref=(e\d+)\]/u);

    // 1. Guarded: the click is a sensitive step whichever way its attachment turns out, so the guard asks first. The
    // Request reaching the fixture is what proves the click really ran and the refusal is the guard's, not a dead link.
    const guardedAt = fixture.brokenHits();
    const guarded = await session.callTool(
      'browser_click',
      { element: 'Broken report', target },
      grants
    );

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    expect(guarded.kind === 'error' ? guarded.stepToken : undefined).toEqual(expect.any(String));
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);
    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'downloading a file' }]);
    // The route counts its own hits, so this is the click's request and not a spec-side assumption.
    await expect.poll(() => fixture.brokenHits(), { timeout: 20_000 }).toBeGreaterThan(guardedAt);
    await expectNothingSaved(downloadsPath);

    // 2. The human approved: the identical call with the token runs with the guard off. The route answers 500 with no
    // `Content-Disposition`, so the browser never creates a savable item: nothing is written to the folder, and the
    // Call reports the click as the ordinary success it was rather than claiming a file it never received.
    const approvedAt = fixture.brokenHits();
    const approved = await session.callTool(
      'browser_click',
      { element: 'Broken report', target },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    // The guarded call's approval bought the click, so the route was asked again; the failed body still saves nothing.
    await expect.poll(() => fixture.brokenHits(), { timeout: 20_000 }).toBeGreaterThan(approvedAt);
    await expectNothingSaved(downloadsPath);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('a download that lands after the click is reported on the next call, and the approved repeat keeps one file', async () => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const grants = grant(fixture.url);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Late download E2E session',
    });

    await session.callTool('browser_navigate', { url: `${fixture.url}/page` }, grants);

    const target = await controlRef(session, grants, /link "Download slow report" \[ref=(e\d+)\]/u);

    // 1. Call N: the click. The route holds its response, so the download cannot exist until the test releases it,
    // Which is only after this call has answered.
    const clicked = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants
    );

    expect(clicked).toMatchObject({ isError: false, kind: 'result' });

    // The click answered before the file was even requested: the frame's request is still in flight, held by the route.
    await fixture.waitForLate(1);
    fixture.releaseLate();
    // The browser created the download after the call answered, and the guard's late window stopped it.
    await expectNothingSaved(downloadsPath);

    // 2. Call N+1 — any tool at all — answers with the need, and names the step that started the file.
    const reported = await session.callTool('browser_snapshot', {}, grants);

    expect(reported).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const message = reported.kind === 'error' ? reported.message : '';

    expect(message).toContain("The click on 'Download slow report' started a download of");
    expect(message).toContain(
      'Repeat that click after the download is approved to receive the file.'
    );

    const token = reported.kind === 'error' ? (reported.stepToken ?? '') : '';

    expect(token).not.toBe('');
    await expectNothingSaved(downloadsPath);

    // 3. Repeating the click with the token keeps exactly one file, even though it lands after the call.
    const approved = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants,
      [token]
    );

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    await fixture.waitForLate(2);
    fixture.releaseLate();
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);

    // 4. The token is burned: the identical click is guarded again, and the folder keeps its one file. The held route
    // Answers only after the click, so this call cannot stop the file itself — the next call reports it, as in step 1.
    const reguarded = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants,
      [token]
    );

    expect(reguarded).toMatchObject({ isError: false, kind: 'result' });
    await fixture.waitForLate(3);
    fixture.releaseLate();
    // Each slow click reaches the browser as a download: the third one is cancelled in the late window, so its file
    // Never lands, and the folder keeps the approved file alone.
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
      .toStrictEqual([DOWNLOAD_FILENAME]);
    expect(fixture.lateHits()).toBeGreaterThanOrEqual(3);

    // The third file is reported, so the model is asked again with a fresh token: the burned one bought it nothing.
    const reReported = await session.callTool('browser_snapshot', {}, grants);

    expect(reReported).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const reMessage = reReported.kind === 'error' ? reReported.message : '';
    const reToken = reReported.kind === 'error' ? (reReported.stepToken ?? '') : '';

    expect(reMessage).toContain("The click on 'Download slow report' started a download of");
    expect(reMessage).toContain(
      'Repeat that click after the download is approved to receive the file.'
    );
    expect(reToken).not.toBe('');
    expect(reToken).not.toBe(token);
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
      .toStrictEqual([DOWNLOAD_FILENAME]);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('a navigate to an attachment asks first, then keeps the file once approved', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Download E2E session',
    });

    // A page can start a download with no click at all: the navigate itself is the action.
    const guarded = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DOWNLOAD_PATH}` },
      grants
    );

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);
    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'downloading a file' }]);
    // The navigation reached the fixture: the file was requested, and the guard stopped the item it would write.
    expect(fixture.hits()).toBeGreaterThan(0);
    await expectNothingSaved(downloadsPath);

    const approved = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DOWNLOAD_PATH}` },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );

    // The browser answers a download navigation with an aborted page load; the approved file is reported as the success it is.
    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    expect(approved.kind === 'result' ? approved.text : '').toContain(
      'The file was downloaded; the page did not change.'
    );
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);
    expect(await readDownloadedFile(downloadsPath, DOWNLOAD_FILENAME)).toBe(DOWNLOAD_BODY);
    // The success text names the file the browser wrote, which is the page's own name on this launch.
    expect(approved.kind === 'result' ? approved.text : '').toContain(DOWNLOAD_FILENAME);
    expect(approved.kind === 'result' ? approved.isError : true).toBe(false);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

/** A session with no tab at all: the CLI opens one and sends only `tools.call`, as its first call does. */
const openEmptyAgentSession = async ({
  context,
  extensionId,
  hub,
  sidePanel,
  title,
}: Parameters<typeof openPairedAgentSession>[0]): Promise<{
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
    call: {
      readonly authorized: readonly Record<string, unknown>[];
      readonly sensitive?: readonly string[] | undefined;
    }
  ) => Promise<LocalAgentToolResponse>;
}> => {
  await enableLocalAgents(sidePanel, extensionId);
  await pairAndHandshake({ context, extensionId, hub, sidePanel });

  const controllerId = crypto.randomUUID();

  hub.send({ controllerId, type: 'controller.connected' });

  const opened = await sendAgentRpc(hub, controllerId, 1, 'session.open', {
    cliVersion: '1.4.0',
    cwd: '/Users/igor/Projects/kilo-bridge-e2e',
    sessionId: `session-${controllerId}`,
    title,
  });
  const { sessionHandle } = z.object({ sessionHandle: z.string() }).parse(opened.result);
  let nextId = 10;

  return {
    callTool: async (name, args, { authorized, sensitive }) => {
      nextId += 1;

      const answer = await sendAgentRpc(hub, controllerId, nextId, 'tools.call', {
        arguments: args,
        authorized,
        name,
        ...(sensitive === undefined || sensitive.length === 0 ? {} : { sensitive }),
        sessionHandle,
      });

      if (answer['error'] !== undefined) {
        const error = z
          .object({
            code: z.number(),
            data: z.record(z.string(), z.unknown()).optional(),
            message: z.string(),
          })
          .parse(answer['error']);
        const data = error.data ?? {};
        const items = z.array(z.record(z.string(), z.unknown())).safeParse(data['items']);
        const step = z
          .object({ argumentsHash: z.string(), tool: z.string() })
          .safeParse(data['step']);
        const stepToken = z.string().safeParse(data['stepToken']);

        return {
          code: error.code,
          kind: 'error',
          message: error.message,
          ...(items.success ? { items: items.data } : {}),
          ...(step.success ? { step: step.data } : {}),
          ...(stepToken.success ? { stepToken: stepToken.data } : {}),
          ...(data['afterAction'] === true ? { afterAction: true } : {}),
        };
      }

      const result = z
        .object({
          content: z.array(z.record(z.string(), z.unknown())),
          isError: z.boolean().optional(),
        })
        .parse(answer['result']);

      return {
        isError: result.isError === true,
        kind: 'result',
        text: result.content
          .map(part => (typeof part['text'] === 'string' ? part['text'] : ''))
          .join('\n'),
        withheldFrames: [],
      };
    },
  };
};

test('a session\u2019s first navigate to an attachment asks first and keeps one file after approval', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();

    const grants = grant(fixture.url);
    // No tab is shared: the session's first call opens one, and an attachment never loads a document.
    const session = await openEmptyAgentSession({
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Empty session download',
    });
    const navigate = (sensitive?: readonly string[]) =>
      session.callTool(
        'browser_navigate',
        { url: `${fixture.url}${DOWNLOAD_PATH}` },
        { authorized: grants, ...(sensitive === undefined ? {} : { sensitive }) }
      );

    const guarded = await navigate();

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    await expectNothingSaved(downloadsPath);

    const approved = await navigate([guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    expect(approved.kind === 'result' ? approved.text : '').toContain(
      'The file was downloaded; the page did not change.'
    );
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);

    // The token is burned: the same call again is guarded, and no second file appears.
    const again = await navigate([guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']);

    expect(again).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
      .toStrictEqual([DOWNLOAD_FILENAME]);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('a first browser_tabs new to an attachment asks first, and its approved repeat keeps one file in its tab', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const grants = grant(fixture.url);
    const session = await openEmptyAgentSession({
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Tabs-new download E2E session',
    });

    const url = `${fixture.url}${DOWNLOAD_PATH}`;
    const params = { action: 'new', url };

    // The call names the `browser_tabs` call the model made: the CLI keys its token by exactly that.
    const guarded = await session.callTool('browser_tabs', params, { authorized: grants });

    expect([
      guarded.kind === 'error' ? guarded.code : undefined,
      guarded.kind === 'error' ? guarded.afterAction : undefined,
      guarded.kind === 'error' ? guarded.step : undefined,
    ]).toStrictEqual([
      -32_010,
      true,
      { argumentsHash: hashBrowserToolArguments(params), tool: 'browser_tabs' },
    ]);

    const token = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    if (token === '') {
      throw new Error('the refusal carried no step token');
    }

    await expectNothingSaved(downloadsPath);

    // The refused call already opened its tab; the repeat must not open another.
    const tabsAfterGuard = await openTabIds(sidePanel);

    // The CLI repeats the `browser_tabs` call with the token: the runtime drives the tab that step opened.
    const approved = await session.callTool('browser_tabs', params, {
      authorized: grants,
      sensitive: [token],
    });

    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);

    const text = approved.kind === 'result' ? approved.text : '';

    expect({
      isError: approved.kind === 'result' ? approved.isError : true,
      keptReport: text.includes('The file was downloaded; the page did not change.'),
      named: text.includes(DOWNLOAD_FILENAME),
      tabs: await openTabIds(sidePanel),
    }).toStrictEqual({ isError: false, keptReport: true, named: true, tabs: tabsAfterGuard });
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('an approved repeat of a browser_tabs new download reports where its navigation settled', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  // A second loopback server is where the repeat's request redirects: it is not named in the grants.
  const landing = await startFakeHub();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const grants = grant(fixture.url);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Tabs-new repeat download E2E session',
    });

    await session.callTool('browser_navigate', { url: `${fixture.url}/page` }, grants);

    const landingOrigin = `http://127.0.0.1:${String(landing.port)}`;
    // The same `browser_tabs` call, twice: the route serves the attachment to the first request and redirects every
    // Later one to the landing server, so the repeat loads a page and the tab settles on the landing origin.
    const url = `${fixture.url}${ONCE_DOWNLOAD_PATH}?next=${encodeURIComponent(landing.pageUrl)}`;
    const params = { action: 'new', url };
    const call = (id: number, sensitive?: readonly string[]) =>
      sendAgentRpc(hub, session.controllerId, id, 'tools.call', {
        arguments: params,
        authorized: grants,
        name: 'browser_tabs',
        ...(sensitive === undefined ? {} : { sensitive }),
        sessionHandle: session.sessionHandle,
      });

    // 1. Guarded: the first request is an attachment, its download is refused, and its step token is issued.
    const guarded = await call(900);

    const guardedError = z
      .object({ code: z.number(), data: z.record(z.string(), z.unknown()), message: z.string() })
      .parse(guarded.error);

    expect(guardedError.code).toBe(LOCAL_AGENT_ERROR_CODES.needsPermission);
    expect(guardedError.data['afterAction']).toBe(true);
    expect(guardedError.data['step']).toStrictEqual({
      argumentsHash: hashBrowserToolArguments(params),
      tool: 'browser_tabs',
    });
    expect(z.array(permissionItemSchema).parse(guardedError.data['items'])).toStrictEqual([
      { class: 'sensitive', origin: fixture.url, reason: 'downloading a file' },
    ]);
    await expectNothingSaved(downloadsPath);

    const token = z.string().parse(guardedError.data['stepToken']);
    // The refused call opened the tab its repeat runs on, so a second tab would be a second download.
    const tabsAfterGuard = await openTabIds(sidePanel);

    // 2. The human approved: the identical call with the token requests the route again, which answers a redirect.
    const approved = await call(901, [token]);

    const changed = z
      .object({ code: z.number(), data: z.record(z.string(), z.unknown()) })
      .parse(approved.error);

    // The tab settled on the landing origin, so the answer names both origins the navigation involved.
    expect([changed.code, changed.data]).toStrictEqual([
      LOCAL_AGENT_ERROR_CODES.originChanged,
      { from: fixture.url, to: landingOrigin },
    ]);

    // The repeat reached the route and got the redirect, kept no file, and opened no second tab.
    expect(fixture.onceHits()).toBe(2);
    await expectNothingSaved(downloadsPath);
    expect(await openTabIds(sidePanel)).toStrictEqual(tabsAfterGuard);
  } finally {
    await launch.close();
    await hub.close();
    await landing.close();
    await fixture.close();
  }
});

test('a browser_tabs new to an attachment on a session that has a tab is guarded, and keeps no file', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const grants = grant(fixture.url);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Tabs-new download E2E session',
    });

    await session.callTool('browser_navigate', { url: `${fixture.url}/page` }, grants);

    // The session already holds a tab: a `browser_tabs new` at the attachment must still be guarded.
    const guarded = await session.callTool(
      'browser_tabs',
      { action: 'new', url: `${fixture.url}${DOWNLOAD_PATH}` },
      grants
    );

    expect([
      guarded.kind === 'error' ? guarded.code : undefined,
      guarded.kind === 'error' ? guarded.afterAction : undefined,
      guarded.kind === 'error' ? guarded.step?.tool : undefined,
    ]).toStrictEqual([-32_010, true, 'browser_tabs']);

    // The file was refused before it could be written: the folder stays empty and nothing is named as saved.
    await expectNothingSaved(downloadsPath);
    expect(guarded.kind === 'error' ? guarded.message.includes('already saved') : true).toBe(false);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('one click that starts two files: the guarded call keeps none, and the approved repeat keeps only its own', async () => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  // Chrome's own multiple-downloads limiter refuses the second file this one gesture starts, which is not what this
  // Spec measures: the hold's answer for two files. Only this spec allows it.
  const launch = await launchRealDownloadBrowser({ automaticDownloads: true });
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}${TWO_DOWNLOADS_PAGE_PATH}`);

    const grants = grant(fixture.url);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, fixture.url);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Two downloads E2E session',
    });

    await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${TWO_DOWNLOADS_PAGE_PATH}` },
      grants
    );

    const target = await controlRef(
      session,
      grants,
      /button "Download both reports" \[ref=(e\d+)\]/u
    );

    // 1. One click, two attachments: the guard decides each item, and neither may finish.
    const guarded = await session.callTool(
      'browser_click',
      { element: 'Download both reports', target },
      grants
    );

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    expect(fixture.hits()).toBeGreaterThan(0);
    expect(fixture.secondHits()).toBeGreaterThan(0);
    await expectNothingSaved(downloadsPath);

    const token = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    expect(token).not.toBe('');

    // 2. The approved repeat is the step's own file only: report.txt lands, second.txt is refused and reported.
    const approved = await session.callTool(
      'browser_click',
      { element: 'Download both reports', target },
      grants,
      [token]
    );

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);
    expect(await readDownloadedFile(downloadsPath, DOWNLOAD_FILENAME)).toBe(DOWNLOAD_BODY);
    expect(await downloadFiles(downloadsPath)).not.toContain(SECOND_DOWNLOAD_FILENAME);

    // The file the approval did not cover is reported — on this call, or the next one that carries the news.
    const approvedText = approved.kind === 'result' ? approved.text : '';
    const next = await session.callTool('browser_snapshot', {}, grants);
    const nextText = next.kind === 'error' ? next.message : next.text;

    expect(`${approvedText}\n${nextText}`).toContain(SECOND_DOWNLOAD_FILENAME);
    // The report never turns into a second file, and the approved one is untouched.
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
      .toStrictEqual([DOWNLOAD_FILENAME]);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test("the user's own download in another tab lands during an approved call and is never reported", async () => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();
    // A page with no agent attached: the session never shares it, so its download is the user's own.
    const userPage = await context.newPage();

    await userPage.goto(`${fixture.url}${USER_PAGE_PATH}`);
    await agentPage.goto(`${fixture.url}/page`);

    const grants = grant(fixture.url);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'User download E2E session',
    });

    await session.callTool('browser_navigate', { url: `${fixture.url}/page` }, grants);

    const target = await downloadRef(session, grants);
    const guarded = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants
    );

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    await expectNothingSaved(downloadsPath);

    const token = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    if (token === '') {
      throw new Error('the refusal carried no step token');
    }

    // The approved call runs while the user starts their own download in a tab no agent holds. A page opened
    // Over CDP is a background tab, and Playwright's actionability waits for an animation frame a hidden tab
    // Never runs: the user's click would hang for the whole test. A user clicking their own tab fronts it first.
    await userPage.bringToFront();

    const [approved] = await Promise.all([
      session.callTool('browser_click', { element: 'Download report', target }, grants, [token]),
      (async () => {
        await userPage.click(`a[href="${USER_DOWNLOAD_PATH}"]`);
      })(),
    ]);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    // Both files finished under their own names: the agent's, and the user's.
    await expect
      .poll(() => downloadFiles(downloadsPath), { timeout: 20_000 })
      .toStrictEqual(
        [DOWNLOAD_FILENAME, USER_DOWNLOAD_FILENAME].toSorted((left, right) =>
          left.localeCompare(right)
        )
      );
    expect(fixture.userHits()).toBeGreaterThan(0);

    // The user's file is never reported; the next call is an ordinary answer, not a permission refusal.
    const approvedText = approved.kind === 'result' ? approved.text : '';
    const next = await session.callTool('browser_snapshot', {}, grants);
    const nextText = next.kind === 'error' ? next.message : next.text;

    expect(approvedText).not.toContain(USER_DOWNLOAD_FILENAME);
    expect(nextText).not.toContain(USER_DOWNLOAD_FILENAME);
    expect(await downloadFiles(downloadsPath)).toContain(USER_DOWNLOAD_FILENAME);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('a payment-form submit receives its own approval, and so does the file it starts', async () => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}${CARD_PAGE_PATH}`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}${CARD_PAGE_PATH}`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Card download E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${CARD_PAGE_PATH}` },
      grants
    );

    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    const target = await controlRef(session, grants, /button "Get receipt" \[ref=(e\d+)\]/u);
    const args = { element: 'Get receipt', target };

    // 1. The submit is a sensitive step: the call is refused before the page runs, with no `afterAction`.
    const asked = await session.callTool('browser_click', args, grants);

    expect(asked).toMatchObject({ code: -32_010, kind: 'error' });
    expect(asked.kind === 'error' ? asked.afterAction : 'not a refusal').toBeUndefined();
    const askedItems = z
      .array(permissionItemSchema)
      .parse(asked.kind === 'error' ? asked.items : []);

    expect(askedItems).toStrictEqual([
      { class: 'sensitive', origin, reason: 'submitting a form with payment fields' },
    ]);
    const sensitiveToken = asked.kind === 'error' ? (asked.stepToken ?? '') : '';

    expect(sensitiveToken).not.toBe('');
    await expectNothingSaved(downloadsPath);

    // 2. The submit runs on the form's approval; the file it starts takes an approval of its own.
    const guarded = await session.callTool('browser_click', args, grants, [sensitiveToken]);

    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const guardedItems = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);

    expect(guardedItems).toStrictEqual([
      { class: 'sensitive', origin, reason: 'downloading a file' },
    ]);
    const downloadToken = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    expect(downloadToken).not.toBe('');
    // The refusal names the file, and the attachment route served it: the click ran.
    expect(guarded.kind === 'error' ? guarded.message : '').toContain(DOWNLOAD_FILENAME);
    expect(fixture.hits()).toBeGreaterThan(0);
    await expectNothingSaved(downloadsPath);

    // 3. The file's own approval keeps that file; its token binds the element the gate classified.
    const approved = await session.callTool('browser_click', args, grants, [downloadToken]);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    await expectOnlyFinishedFile(downloadsPath, DOWNLOAD_FILENAME);
    expect(await readDownloadedFile(downloadsPath, DOWNLOAD_FILENAME)).toBe(DOWNLOAD_BODY);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object destructured, and this spec takes no fixture: every page is opened on the launch's own context.
test('a drop that carries local file paths needs the upload approval', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  // A real file outside the browser's profile: the drop hands the page its contents, which is what an approval covers.
  const localDir = await mkdtemp(join(tmpdir(), 'kilo-drop-proof-'));
  const localPath = join(localDir, 'drop-proof.txt');

  await writeFile(localPath, 'drop fixture body\n');

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}${DROP_PAGE_PATH}`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}${DROP_PAGE_PATH}`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Drop upload E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DROP_PAGE_PATH}` },
      grants
    );

    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    await recordDropsOnPage(agentPage);
    const dropRecord = agentPage.locator('#drop-record');

    await expect(dropRecord).toHaveText('Drop record: nothing received yet');
    await agentPage.screenshot({
      fullPage: true,
      path: testInfo.outputPath('drop-page-before.png'),
    });

    // A `region` is not an interactive role, so it carries no `[ref=eN]`: the drop names a unique CSS selector.
    const args = { element: 'Drop zone', paths: [localPath], target: '#zone' };

    // 1. A drop of local paths is an upload: the call is refused before it runs, so the page reports no drop.
    const guarded = await session.callTool('browser_drop', args, grants);

    expect(guarded).toMatchObject({ code: -32_010, kind: 'error' });
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);

    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'uploading a file' }]);
    const token = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    expect(token).not.toBe('');
    await expect.poll(() => fixture.dropReceived(), { timeout: 5000 }).toStrictEqual([]);
    // The refusal happened before the tool ran, so the page's own record still shows nothing.
    await expect(dropRecord).toHaveText('Drop record: nothing received yet');

    // 2. The human approved: the same drop runs and the page receives the one file.
    const approved = await session.callTool('browser_drop', args, grants, [token]);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    await expect
      .poll(() => fixture.dropReceived(), { timeout: 20_000 })
      .toStrictEqual([['drop-proof.txt']]);
    // The page shows the file the approved drop handed it, with the 18 bytes the local file holds.
    await expect(dropRecord).toHaveText('Drop record: drop-proof.txt (18 bytes)');
    expect(await agentPage.evaluate('window.__droppedReads')).toStrictEqual(['readable']);
    await agentPage.screenshot({
      fullPage: true,
      path: testInfo.outputPath('drop-page-after.png'),
    });

    // 3. A drop of page-made data is not an upload: it runs on its own.
    const dataOnly = await session.callTool(
      'browser_drop',
      { data: { 'text/plain': 'hello' }, element: 'Drop zone', target: '#zone' },
      grants
    );

    expect(dataOnly).toMatchObject({ isError: false, kind: 'result' });

    // The panel is the last capture: bringing it to the front makes the fixture page a background tab.
    await screenshotConnectedAgent(sidePanel, testInfo.outputPath('extension-connected-agent.png'));
  } finally {
    await rm(localDir, { force: true, recursive: true });
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

test('the no-permission fallback refuses the same click and names the grant', async () => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  // The shipped manifest keeps `downloads` optional, so this copy loads without it: `chrome.downloads` is undefined and
  // The runtime has no event to hold an item with. What is left is the response that would become a file.
  const launch = await launchRealDownloadBrowser({ grantPermissions: [] });
  const { context, downloadsPath, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(false) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}/page`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'No permission E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}/page` },
      grants
    );
    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    const target = await downloadRef(session, grants);
    const guardedAt = fixture.hits();
    const guarded = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants
    );

    // The click ran and its attachment response was failed before a byte landed, so the refusal names the file the
    // Model would have reported and asks for the grant instead. No token is offered: without the permission there is
    // No guard an approval could switch off, so a token here would be one nobody could ever spend.
    expect(guarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    expect(guarded.kind === 'error' ? guarded.message : '').toContain(
      'optional Downloads permission'
    );
    expect(guarded.kind === 'error' ? guarded.stepToken : 'a step token').toBeUndefined();
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);
    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'downloading a file' }]);

    // The route counts its own hits, so the request reaching it is the click's and not a spec-side assumption.
    await expect.poll(() => fixture.hits(), { timeout: 20_000 }).toBeGreaterThan(guardedAt);
    await expectNothingSaved(downloadsPath);

    // The launch really lacks the permission: nothing in this spec promoted it, and the state is the browser's own.
    expect(await sidePanel.evaluate('typeof chrome.downloads')).toBe('undefined');
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object destructured, and this spec takes no fixture: every page is opened on the launch's own context.
test('a drop naming an absent local file is still the upload step, and the page receives nothing', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const launch = await launchRealDownloadBrowser();
  const { context, extensionId } = launch;
  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await agentPage.goto(`${fixture.url}${DROP_PAGE_PATH}`);

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}${DROP_PAGE_PATH}`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Absent drop upload E2E session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DROP_PAGE_PATH}` },
      grants
    );

    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    // The page is the only witness to what a drop really handed it: it reports names to the fixture, and the helper
    // Also records the file's byte count and whether those bytes can be read at all, before any drop reaches this page.
    await recordDropsOnPage(agentPage);
    const dropRecord = agentPage.locator('#drop-record');

    await expect(dropRecord).toHaveText('Drop record: nothing received yet');
    await agentPage.screenshot({
      fullPage: true,
      path: testInfo.outputPath('drop-page-before.png'),
    });

    // The guard decides the call before the tool runs, so a path that is not on disk is classified the same way a
    // Readable one is: the upload approval is what the call needs, and no read of the paths happens first.
    const args = {
      element: 'Drop zone',
      paths: ['/nonexistent/absent-proof.txt'],
      target: '#zone',
    };
    const guarded = await session.callTool('browser_drop', args, grants);

    expect(guarded).toMatchObject({ code: -32_010, kind: 'error' });
    const items = z
      .array(permissionItemSchema)
      .parse(guarded.kind === 'error' ? guarded.items : []);

    expect(items).toStrictEqual([{ class: 'sensitive', origin, reason: 'uploading a file' }]);
    const token = guarded.kind === 'error' ? (guarded.stepToken ?? '') : '';

    expect(token).not.toBe('');
    // Refused before the tool: the page's own handler never ran, so it reported no drop.
    await expect.poll(() => fixture.dropReceived(), { timeout: 5000 }).toStrictEqual([]);
    await expect(dropRecord).toHaveText('Drop record: nothing received yet');

    // The approval buys the step, and the tool answers as it always does — it dispatched a drag the browser accepted.
    // Nothing was delivered: the file the page was handed holds no bytes and cannot be read, so the page's report of
    // Its name is a name alone. The assertions below are what that file turned out to be, not what the answer claimed.
    const approved = await session.callTool('browser_drop', args, grants, [token]);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    expect(approved.kind === 'result' ? approved.text : '').toContain('1 file(s)');

    const handed = z
      .array(z.object({ name: z.string(), size: z.number() }))
      .parse(await agentPage.evaluate('window.__droppedFiles'));

    expect(handed).toStrictEqual([{ name: 'absent-proof.txt', size: 0 }]);
    const reads = z.array(z.string()).parse(await agentPage.evaluate('window.__droppedReads'));

    expect(reads).toStrictEqual([expect.stringContaining('NotFoundError')]);
    // The page ran and named the file the browser described, with no contents behind it. The report is a
    // Fire-and-forget fetch, so it fills independently of the call that returned: poll it like the drop spec above.
    await expect
      .poll(() => fixture.dropReceived(), { timeout: 20_000 })
      .toStrictEqual([['absent-proof.txt']]);
    // The page shows the name it was handed with no bytes behind it: the refusal and the approval both happened,
    // And what reached the page is the empty file the browser described.
    await expect(dropRecord).toHaveText('Drop record: absent-proof.txt (0 bytes)');
    await agentPage.screenshot({
      fullPage: true,
      path: testInfo.outputPath('drop-page-after.png'),
    });
    await screenshotConnectedAgent(sidePanel, testInfo.outputPath('extension-connected-agent.png'));
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});
