/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec reads a real downloads directory and drives a real hub session */
import { expect, test } from '@playwright/test';
import type { Download } from '@playwright/test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  DOWNLOAD_BODY,
  DOWNLOAD_FILENAME,
  DOWNLOAD_PATH,
  startDownloadFixture,
} from './download-fixture';
import { launchExtensionContext } from './extension-context-fixture';
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

/*
 * SPEC "Permission flow" step 6 and the wire contract §3: an agent `act` call
 * that starts a download cancels it and answers `needs_permission` with
 * `afterAction: true`; the identical call re-sent with that step token runs
 * once with the guard off. The downloads directory is a real directory, so
 * "the file did not land" is a directory read rather than an event count.
 *
 * `downloads` is an optional permission and this run does not have it, which is
 * the state every existing user starts in: the guard is the response-stage
 * interception, and the page's file never becomes a download.
 */

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

const permissionItemSchema = z.object({
  class: z.string(),
  origin: z.string(),
  reason: z.string().optional(),
});

const refPattern = /link "Download report" \[ref=(e\d+)\]/u;

/** The download link's ref from a fresh snapshot of the fixture page. */
const downloadRef = async (
  session: LocalAgentSession,
  grants: readonly Record<string, unknown>[]
) => {
  const snapshot = await session.callTool('browser_snapshot', {}, grants);

  if (snapshot.kind !== 'result') {
    throw new Error(`browser_snapshot failed: ${JSON.stringify(snapshot)}`);
  }

  const ref = refPattern.exec(snapshot.text)?.[1];

  if (ref === undefined) {
    throw new Error(`no download link in snapshot:\n${snapshot.text}`);
  }

  return ref;
};

test('a guarded click cancels the download, and the approved retry keeps it', async () => {
  test.setTimeout(120_000);
  const downloadsPath = await mkdtemp(join(tmpdir(), 'kilo-downloads-'));
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({
    downloadsPath,
    // The state after the switch's permission prompt is accepted; automation cannot answer it.
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

    // 1. Guarded: the click runs once, the download it starts is cancelled, and the call refuses.
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

    // The browser created the download and the guard cancelled it, so nothing reached the directory.
    await expect.poll(() => readdir(downloadsPath), { timeout: 15_000 }).toStrictEqual([]);
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(1);
    // `cancel` may lose a race with a file this small, in which case the guard deletes the completed file instead.
    // Either way the item may not leave a file behind, so no particular failure string is required.
    for (const download of downloads) {
      // eslint-disable-next-line no-await-in-loop -- one item, and the read depends on where it landed
      const saved = await download.path().catch(() => null);

      if (saved !== null) {
        // eslint-disable-next-line no-await-in-loop -- see above
        await expect(readFile(saved, 'utf8')).rejects.toThrow();
      }
    }

    // 2. The human approved: the identical call with the token runs with the guard off once.
    const approved = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );
    expect(approved).toMatchObject({ isError: false, kind: 'result' });

    // Playwright stores an accepted download under its own name inside the directory; the page named it.
    await expect.poll(() => readdir(downloadsPath), { timeout: 15_000 }).toHaveLength(1);

    const download = downloads.at(-1);

    if (download === undefined) {
      throw new Error('the approved click produced no download');
    }

    expect(download.suggestedFilename()).toBe(DOWNLOAD_FILENAME);
    expect(await download.failure()).toBeNull();
    const saved = await download.path();

    if (saved === null) {
      throw new Error('the approved download has no file on disk');
    }

    expect(await readFile(saved, 'utf8')).toBe(DOWNLOAD_BODY);

    // 3. The token was burned: the same call again is guarded, so the guard is not left off.
    const reguarded = await session.callTool(
      'browser_click',
      { element: 'Download report', target },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );
    expect(reguarded).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    // The approved file is still the only one, unchanged.
    await expect.poll(() => readdir(downloadsPath), { timeout: 10_000 }).toHaveLength(1);
    expect(await readFile(saved, 'utf8')).toBe(DOWNLOAD_BODY);
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(downloadsPath, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a download that lands after the click is reported on the next call, and the approved repeat keeps one file', async () => {
  test.setTimeout(180_000);
  const downloadsPath = await mkdtemp(join(tmpdir(), 'kilo-downloads-'));
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({
    downloadsPath,
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

    const snapshot = await session.callTool('browser_snapshot', {}, grants);
    const target =
      snapshot.kind === 'result'
        ? /link "Download slow report" \[ref=(e\d+)\]/u.exec(snapshot.text)?.[1]
        : undefined;

    if (target === undefined) {
      throw new Error(`no delayed download link in the snapshot:\n${snapshot.kind}`);
    }

    // 1. Call N: the click. The response is held for a second and a half, so nothing lands inside the call.
    const clicked = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants
    );

    expect(clicked).toMatchObject({ isError: false, kind: 'result' });
    // The browser created the download after the call answered, and the guard's late window stopped it.
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(1);
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);

    // 2. Call N+1 — any tool at all — answers with the need, and names the step that started the file.
    const reported = await session.callTool('browser_snapshot', {}, grants);

    expect(reported).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const message = reported.kind === 'error' ? reported.message : '';

    expect(message).toContain("The click on 'Download slow report' started a download of");
    expect(message).toContain('Repeat that click to receive the file.');

    const token = reported.kind === 'error' ? (reported.stepToken ?? '') : '';

    expect(token).not.toBe('');
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);

    // 3. Repeating the click with the token keeps exactly one file, even though it lands after the call.
    const approved = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants,
      [token]
    );

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toHaveLength(1);

    // 4. The token is burned: the identical click is guarded again, and the folder keeps its one file. The slow route
    // Answers only after the click, so this call cannot stop the file itself — the next call reports it, as in step 1.
    const reguarded = await session.callTool(
      'browser_click',
      { element: 'Download slow report', target },
      grants,
      [token]
    );

    expect(reguarded).toMatchObject({ isError: false, kind: 'result' });
    // Each slow click reaches the browser as a download: the third one is cancelled in the late window, so its file
    // Never lands, and the folder keeps the approved file alone.
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(3);
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toHaveLength(1);
    expect(fixture.lateHits()).toBeGreaterThanOrEqual(3);

    // The third file is reported, so the model is asked again with a fresh token: the burned one bought it nothing.
    const reReported = await session.callTool('browser_snapshot', {}, grants);

    expect(reReported).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    const reMessage = reReported.kind === 'error' ? reReported.message : '';
    const reToken = reReported.kind === 'error' ? (reReported.stepToken ?? '') : '';

    expect(reMessage).toContain("The click on 'Download slow report' started a download of");
    expect(reMessage).toContain('Repeat that click to receive the file.');
    expect(reToken).not.toBe('');
    expect(reToken).not.toBe(token);
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toHaveLength(1);
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(downloadsPath, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a navigate to an attachment asks first, then keeps the file once approved', async () => {
  test.setTimeout(120_000);
  const downloadsPath = await mkdtemp(join(tmpdir(), 'kilo-downloads-'));
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({
    downloadsPath,
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
    await expect.poll(() => readdir(downloadsPath), { timeout: 15_000 }).toStrictEqual([]);
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
    await expect.poll(() => readdir(downloadsPath), { timeout: 15_000 }).toHaveLength(1);
    const download = downloads.at(-1);

    if (download === undefined) {
      throw new Error('the approved navigate produced no download');
    }

    expect(download.suggestedFilename()).toBe(DOWNLOAD_FILENAME);
    const saved = await download.path();

    if (saved === null) {
      throw new Error('the approved download has no file on disk');
    }

    expect(await readFile(saved, 'utf8')).toBe(DOWNLOAD_BODY);
    // The success text names the file the browser wrote, which Playwright stores under its own name here.
    expect(approved.kind === 'result' ? approved.text : '').toContain(basename(saved));
    expect(approved.kind === 'result' ? approved.isError : true).toBe(false);
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(downloadsPath, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
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
        const stepToken = z.string().safeParse(data['stepToken']);

        return {
          code: error.code,
          kind: 'error',
          message: error.message,
          ...(items.success ? { items: items.data } : {}),
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
  const downloadsPath = await mkdtemp(join(tmpdir(), 'kilo-downloads-'));
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const { context, extensionId, userDataDir } = await launchExtensionContext({ downloadsPath });
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
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);

    const approved = await navigate([guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']);

    expect(approved).toMatchObject({ isError: false, kind: 'result' });
    expect(approved.kind === 'result' ? approved.text : '').toContain(
      'The file was downloaded; the page did not change.'
    );
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toHaveLength(1);

    // The token is burned: the same call again is guarded, and no second file appears.
    const again = await navigate([guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']);

    expect(again).toMatchObject({ afterAction: true, code: -32_010, kind: 'error' });
    await expect.poll(() => readdir(downloadsPath), { timeout: 20_000 }).toHaveLength(1);
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(downloadsPath, { force: true, recursive: true });
    await rm(userDataDir, { force: true, recursive: true });
  }
});
