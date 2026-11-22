/* eslint-disable import/max-dependencies, import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec reads a real downloads folder and drives a real hub session against a real Chrome */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { LOCAL_AGENT_ERROR_CODES } from '../../src/shared/local-agents/jsonrpc';
import { ONCE_DOWNLOAD_PATH, startDownloadFixture } from './download-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentSession } from './local-agents-fixture';
import {
  downloadFiles,
  launchRealDownloadBrowser,
  tempDownloadFiles,
} from './real-download-launch';

/*
 * SPEC "Permission flow" step 6, and the record a woken worker reads: the download hold
 * mirrors each agent session's tabs and approvals into `storage.session`, so the worker a
 * download wakes decides that file from the record instead of an empty hold. The record
 * belongs to the session, so it holds a session's facts only while that session is live.
 *
 * This spec exercises that with the close and the registration ordered by the spec itself:
 *
 * 1. A guarded navigate to an attachment answers `needs_permission` and issues the step
 *    token a human's approval is bound to, so the session is in the record.
 * 2. The session's browser caller is disposed through the panel path, which is what ends a
 *    session's downloads. The tab group and the registry row stay, so a later call of that
 *    session is still admitted.
 * 3. The approved repeat of step 1 is that later call, and it registers its tab and its
 *    approval in the hold.
 * 4. The record and the real downloads folder then say what the session left behind.
 *
 * `HOLD_CLOSED_SESSION_EXPECT` names the build this run asserts facts for.
 *
 * The attachment's route answers one request and redirects every later one, so step 3 keeps
 * no file: the folder stays empty in both builds, which is asserted rather than assumed.
 * That the repeat really ran is a fact of the same record: its step names the repeat's own
 * navigation, and its `need` is the approval that navigation armed.
 */

/** The build whose assertions this run makes: the reviewed change, or the merge base. */
const EXPECTED_BUILD = process.env['HOLD_CLOSED_SESSION_EXPECT'] ?? 'head';

/** The panel message that disposes one browser caller, as `@/src/shared/tab-debugger` declares it. */
const DISPOSE_BROWSER_CALLER_MESSAGE = 'kilo.tabs.disposeBrowserCaller';

/** The grant set this spec's calls carry: the fixture page's own origin. */
const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

/**
 * Disposes one agent session's browser caller from an extension page, the path the side panel
 * uses when it lets a session go: the session's downloads end there, while its tab group and
 * registry row stay live.
 */
const disposeBrowserCaller = async (page: Page, session: LocalAgentSession): Promise<number> => {
  const answer: unknown = await page.evaluate(
    `chrome.runtime.sendMessage(${JSON.stringify({
      caller: {
        controllerId: session.controllerId,
        kind: 'agent',
        sessionHandle: session.sessionHandle,
      },
      type: DISPOSE_BROWSER_CALLER_MESSAGE,
    })})`
  );
  const parsed = z
    .object({
      ok: z.literal(true),
      released: z.number(),
      type: z.literal(DISPOSE_BROWSER_CALLER_MESSAGE),
    })
    .parse(answer);

  expect(parsed.ok).toBe(true);

  return parsed.released;
};

/** One pause of the harness's own, used as the interval between two reads of one value. */
const after = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, milliseconds);

  return promise;
};

/**
 * The extension's own mirror, read from an extension page. The WXT `session:` prefix
 * selects `storage.session`, so the raw key in that area is the name without the prefix.
 */
const readHoldRecord = (page: Page): Promise<unknown> =>
  page.evaluate(
    "chrome.storage.session.get('kiloDownloadHoldState').then(items => items['kiloDownloadHoldState'] ?? null)"
  );

/**
 * The mirror once it has settled: two reads a poll interval apart that agree are the value
 * every write of the session has already landed, so the assertions read one whole record
 * rather than one caught mid-write.
 */
const settledHoldRecord = async (page: Page): Promise<unknown> => {
  const read = async (): Promise<string> => JSON.stringify(await readHoldRecord(page));
  let previous = await read();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- one poll interval between two reads of the same value
    await after(50);

    // eslint-disable-next-line no-await-in-loop -- the read that decides whether the value has settled
    const next = await read();

    if (next === previous) {
      return JSON.parse(previous) as unknown;
    }

    previous = next;
  }

  return JSON.parse(previous) as unknown;
};

const recordEntrySchema = z.object({
  need: z.object({ kind: z.string() }).optional(),
  owed: z.array(z.unknown()),
  tabs: z.array(z.object({ page: z.string(), session: z.string(), tabId: z.number() })),
});

/** The record's own shape, for the assertions; the annotation keeps the value as it was stored. */
const holdRecordOf = (value: unknown) =>
  value === null ? {} : z.record(z.string(), recordEntrySchema).parse(value);

/** What the record says about each session it names, one line per session, for the run's evidence. */
const recordSummary = (value: unknown) =>
  Object.entries(holdRecordOf(value)).map(([session, entry]) => ({
    need: entry.need?.kind ?? null,
    owed: entry.owed.length,
    session,
    tabs: entry.tabs.map(tab => tab.tabId),
  }));

/** The step token a refusal carries, or a failure that says what the answer was instead. */
const stepTokenOf = (answer: unknown): string => {
  const refused = z
    .object({ code: z.number(), kind: z.literal('error'), stepToken: z.string().optional() })
    .safeParse(answer);

  if (!refused.success) {
    throw new Error(`the call was not refused: ${JSON.stringify(answer)}`);
  }

  expect(refused.data.code).toBe(LOCAL_AGENT_ERROR_CODES.needsPermission);
  expect(refused.data.stepToken).toEqual(expect.any(String));

  return refused.data.stepToken ?? '';
};

/** Nothing landed: no finished file, and no temp file still growing. */
const expectNothingSaved = async (downloadsPath: string): Promise<void> => {
  await expect.poll(() => downloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
  await expect.poll(() => tempDownloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
};

test('a session whose browser caller was disposed keeps no tab or approval of its own', async () => {
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

    const origin = fixture.url;
    const grants = grant(origin);
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${origin}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Closed download session',
    });

    // The attachment answers its first request and redirects every later one to the page, so
    // The approved repeat of the same call loads a page instead of starting a second file.
    const attachmentUrl = `${origin}${ONCE_DOWNLOAD_PATH}?next=${encodeURIComponent(`${origin}/page`)}`;

    // 1. Guarded: the file is stopped, and the session is asked for the approval that buys it.
    const guarded = await session.callTool('browser_navigate', { url: attachmentUrl }, grants);

    expect(guarded).toMatchObject({
      afterAction: true,
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      kind: 'error',
    });
    expect(fixture.onceHits()).toBe(1);
    await expectNothingSaved(downloadsPath);

    const token = stepTokenOf(guarded);

    expect(token).not.toBe('');

    const beforeDispose = await settledHoldRecord(sidePanel);

    // 2. The session's browser caller is disposed, which ends the session's downloads: the
    // Record holds nothing for it from here on. The tab group stays, so the next call is admitted.
    const released = await disposeBrowserCaller(sidePanel, session);

    const afterDispose = await settledHoldRecord(sidePanel);

    // The dispose reached the session the guarded call ran in, and the record holds nothing for
    // It from here on. Its `released` count is the leases the caller still held, and a call gives
    // Its own back at turn end, so the record is the evidence here rather than that count.
    expect(holdRecordOf(beforeDispose)[session.sessionHandle]).toBeDefined();
    expect(holdRecordOf(afterDispose)[session.sessionHandle]).toBeUndefined();

    // 3. The approved repeat runs after that close. It is admitted (the group is live) and
    // Registers its tab and its approval in the hold, which a live record keeps and a closed one does not.
    const repeat = await session.callTool('browser_navigate', { url: attachmentUrl }, grants, [
      token,
    ]);

    const record = await settledHoldRecord(sidePanel);
    const folder = {
      finished: await downloadFiles(downloadsPath),
      temporary: await tempDownloadFiles(downloadsPath),
    };

    test.info().annotations.push(
      { description: JSON.stringify(beforeDispose), type: 'hold-record-before-dispose' },
      { description: JSON.stringify(afterDispose), type: 'hold-record-after-dispose' },
      { description: JSON.stringify(record), type: 'hold-record' },
      { description: JSON.stringify(recordSummary(record)), type: 'hold-record-summary' },
      {
        description: JSON.stringify(
          record === null ? [] : Object.keys(z.record(z.string(), z.unknown()).parse(record))
        ),
        type: 'hold-record-keys',
      },
      { description: JSON.stringify({ once: fixture.onceHits(), released }), type: 'dispose' },
      { description: JSON.stringify(repeat), type: 'approved-repeat' },
      { description: JSON.stringify(folder), type: 'download-folder' }
    );

    // The repeat was admitted after the close — a rejected call would answer `session_lost` or
    // `blocked` here — and its own request reached the route, which answered it with a page.
    expect(repeat).toMatchObject({ isError: false, kind: 'result' });
    expect(repeat.kind === 'result' ? repeat.text : '').toContain(`${origin}/page`);
    expect(fixture.onceHits()).toBe(2);

    if (EXPECTED_BUILD === 'base') {
      // The writes of step 3 register a tab and an approval for the session, so the record names
      // It again with that tab and that approval, and its step is the repeat's own navigation
      // Rather than the guarded call before the close.
      const entry = holdRecordOf(record)[session.sessionHandle];

      expect(entry).toBeDefined();
      expect(entry?.need?.kind).toBe('armed');
      expect(entry?.tabs.map(tab => tab.tabId)).toStrictEqual([session.tabId]);
    } else {
      // The close is what the record ends with: it holds no entry for the disposed session.
      expect(holdRecordOf(record)[session.sessionHandle]).toBeUndefined();
      expect(Object.keys(holdRecordOf(record))).toStrictEqual([]);
    }

    // The repeat's own request is answered with a page, so no file was written either way.
    await expectNothingSaved(downloadsPath);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
  }
});
