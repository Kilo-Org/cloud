/* eslint-disable import/max-dependencies, import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec reads a real downloads directory and drives a real hub session */
import { expect, test } from '@playwright/test';
import type { Download } from '@playwright/test';
import { z } from 'zod';
import { hashBrowserToolArguments } from '../../src/shared/browser-agent-checks';
import {
  DOWNLOAD_BODY,
  DOWNLOAD_FILENAME,
  DOWNLOAD_PATH,
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

/** How many tabs the browser holds, from a `browser_tabs list` answer: the same count is how "no second tab" shows. */
const listedTabCount = (answer: LocalAgentToolResponse): number => {
  const parsed: unknown = JSON.parse(answer.kind === 'result' ? answer.text : '{"tabs":[]}');

  return z.object({ tabs: z.array(z.record(z.string(), z.unknown())) }).parse(parsed).tabs.length;
};

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
    const downloads: Download[] = [];

    agentPage.on('download', download => downloads.push(download));

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

    // The browser created the item and the guard stopped it before it settled, so nothing is in the folder.
    await expectNothingSaved(downloadsPath);
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);

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
    const downloads: Download[] = [];

    agentPage.on('download', download => downloads.push(download));
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
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(1);
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
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(3);
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
    const downloads: Download[] = [];

    agentPage.on('download', download => downloads.push(download));
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
    await expectNothingSaved(downloadsPath);
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);

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
    const downloads: Download[] = [];

    context.on('page', page => page.on('download', download => downloads.push(download)));

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
    const tabsAfterGuard = listedTabCount(
      await session.callTool('browser_tabs', { action: 'list' }, { authorized: grants })
    );

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
      tabs:
        listedTabCount(
          await session.callTool('browser_tabs', { action: 'list' }, { authorized: grants })
        ) === tabsAfterGuard,
    }).toStrictEqual({ isError: false, keptReport: true, named: true, tabs: true });
  } finally {
    await launch.close();
    await hub.close();
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
    const downloads: Download[] = [];

    agentPage.on('download', download => downloads.push(download));
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

    // The approved call runs while the user starts their own download in a tab no agent holds.
    const userDownload = userPage.waitForEvent('download');
    const [approved] = await Promise.all([
      session.callTool('browser_click', { element: 'Download report', target }, grants, [token]),
      (async () => {
        await userPage.click(`a[href="${USER_DOWNLOAD_PATH}"]`);

        return userDownload;
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
