/* eslint-disable import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec reads a real downloads directory and drives a real hub session */
import { expect, test } from '@playwright/test';
import type { Download } from '@playwright/test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DOWNLOAD_BODY, DOWNLOAD_FILENAME, startDownloadFixture } from './download-fixture';
import { launchExtensionContext } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentSession } from './local-agents-fixture';

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
  const { context, extensionId, userDataDir } = await launchExtensionContext({ downloadsPath });
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

    // The response was aborted before it became a download: no file, and no download announced at all.
    await expect.poll(() => readdir(downloadsPath), { timeout: 15_000 }).toStrictEqual([]);
    expect(downloads).toStrictEqual([]);
    // Any outcome Playwright did report is awaited: a `null` failure means a file landed.
    const failures = await Promise.all(downloads.map(download => download.failure()));

    expect(failures.filter(failure => failure === null)).toStrictEqual([]);

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
