/* eslint-disable import/max-dependencies, import/no-nodejs-modules, max-lines, promise/avoid-new, vitest/no-conditional-in-test -- the spec writes a throwaway copy of the build, restarts its worker over CDP and reads a real downloads folder */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DOWNLOAD_HOLD_STATE_KEY } from '../../src/shared/browser-download-hold-record';
import { LOCAL_AGENT_ERROR_CODES } from '../../src/shared/local-agents/jsonrpc';
import { DOWNLOAD_FILENAME, DOWNLOAD_PATH, startDownloadFixture } from './download-fixture';
import { extensionPath } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import {
  downloadFiles,
  launchRealDownloadBrowser,
  tempDownloadFiles,
} from './real-download-launch';

/*
 * The download hold mirrors each agent session's tabs, owed reports and approvals into one
 * `storage.session` value, and every write replaces that value whole. A worker that wakes to a
 * download decides the file from that record, so the record is written only once it has been read:
 * a generation that does not get an answer from the area answers from its live hold and stores
 * nothing, and the next boot reads the value its last writer left.
 *
 * This spec checks that rule on the built extension, with no change to product source: the launch
 * loads a copy of the build whose background worker refuses the record's own key in
 * `chrome.storage.session.get` and then runs the real `background.js` at its top level
 * (`importScripts` from a promise callback is refused by Chrome, so the patch and the real script
 * are both top-level statements). The refusal is scoped to that key on purpose: the same area holds
 * the tab leases and the tab groups, and a worker whose every session read failed never opens a
 * session at all.
 *
 * The record under test is written by an extension page before the worker restarts, and holds one
 * session with one tab and one armed approval. The build's own worker is restarted without a page
 * reload by closing its service-worker target over CDP and waking it from the panel, so the next
 * generation boots against the same refusing read. The spec then asserts, in the new generation:
 *
 * 1. its read of `chrome.storage.session` rejects, which is the proof this boot ran against an
 *    area that does not answer;
 * 2. the record an extension page reads back is the seeded record, byte for byte, so nothing in
 *    the new worker stored over it;
 * 3. the extension still serves downloads after the restart, and the record is still untouched
 *    after that download, so an unread mirror answers from the live hold and stores nothing.
 *
 * The wrapper refuses the read in every generation, so no worker ever restores the record: the new
 * generation's live hold owns no tab, and the download this spec drives is the one thing an empty
 * hold answers — it is not held, and the browser writes it. A held file would need the record
 * applied, which the wrapper never gives; the hold's own decisions on a live registration are
 * covered by the unit cases in `browser-download-hold.test.ts`.
 *
 * The spec is the regression guard for that rule, and the same file runs unchanged against the
 * merge-base build.
 */

/** The raw `storage.session` key: the host's exported constant without the WXT `session:` prefix. */
const HOLD_STATE_STORAGE_KEY = DOWNLOAD_HOLD_STATE_KEY.replace(/^session:/, '');

/**
 * The wrapper worker: refuse the record's own read, then run the real background script. Both calls
 * are top-level statements, because Chrome refuses `importScripts` inside a promise callback. The
 * probe record it leaves on the global is how a generation reports itself: its boot time tells the
 * restart apart and its `patched` flag says the refusal is in place.
 */
const WRAPPER_SERVICE_WORKER = `/* kilo e2e: a download-hold record that stays as written */
(() => {
  const probe = (globalThis.__kiloRecordRetention = { bootedAt: Date.now(), patched: false });
  const key = ${JSON.stringify(HOLD_STATE_STORAGE_KEY)};
  const original = chrome.storage.session.get.bind(chrome.storage.session);
  const namesOf = keys => {
    if (typeof keys === 'string') {
      return [keys];
    }
    if (Array.isArray(keys)) {
      return keys.map(String);
    }
    return keys === null || keys === undefined ? [] : Object.keys(keys);
  };

  // The refusal is scoped to the record's own key: the same area holds the tab leases and the tab
  // Groups, and a worker whose every session read failed would break far more than this decision.
  const refused = function get(keys) {
    if (namesOf(keys).some(name => name === key || name.endsWith(':' + key))) {
      return Promise.reject(new Error('kilo e2e: the record read is refused'));
    }

    return original(...arguments);
  };

  chrome.storage.session.get = refused;
  probe.patched = chrome.storage.session.get === refused;

  importScripts('./background.js');
})();
`;

/**
 * The wrapper worker with a budget: like the one above, but the record's own read is refused only as many times as
 * `chrome.storage.local` says. The budget is read and decremented before the refusal, so the boot read of a
 * generation spends one refusal and the spend's own retry read is answered. `refused` counts the refusals this
 * generation made, which is how the spec proves its boot ran against an area that did not answer.
 */
const WRAPPER_SERVICE_WORKER_BUDGETED = `/* kilo e2e: a download-hold record whose read is refused a limited number of times */
(() => {
  const probe = (globalThis.__kiloRecordRetention = { bootedAt: Date.now(), patched: false, refused: 0 });
  const key = ${JSON.stringify(HOLD_STATE_STORAGE_KEY)};
  const budgetKey = 'kiloE2eRefusalBudget';
  const original = chrome.storage.session.get.bind(chrome.storage.session);
  const namesOf = keys => {
    if (typeof keys === 'string') {
      return [keys];
    }
    if (Array.isArray(keys)) {
      return keys.map(String);
    }
    return keys === null || keys === undefined ? [] : Object.keys(keys);
  };

  // The refusal is scoped to the record's own key, and the budget read is awaited before the refusal: a decrement
  // That never landed would refuse every later read too, and the spend's own retry could never be answered.
  const refused = async function get(keys) {
    if (namesOf(keys).some(name => name === key || name.endsWith(':' + key))) {
      const stored = await chrome.storage.local.get(budgetKey);
      const budget = stored[budgetKey];

      if (typeof budget === 'number' && budget > 0) {
        await chrome.storage.local.set({ [budgetKey]: budget - 1 });
        probe.refused += 1;
        throw new Error('kilo e2e: the record read is refused');
      }
    }

    return original(...arguments);
  };

  chrome.storage.session.get = refused;
  probe.patched = chrome.storage.session.get === refused;

  importScripts('./background.js');
})();
`;

const manifestSchema = z.looseObject({
  optional_permissions: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
});

/**
 * A copy of the built extension whose background is the wrapper. `downloads` is granted here rather
 * than through the launch, which only rewrites its own copy of the build: without the permission the
 * hold's listener never exists, and a download would prove nothing about it.
 */
const writeRecordRetentionExtension = async (
  wrapper: string = WRAPPER_SERVICE_WORKER
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'kilo-record-retention-'));

  await cp(extensionPath, directory, { recursive: true });

  const manifestPath = join(directory, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));

  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      background: { service_worker: 'sw.js' },
      optional_permissions: (manifest.optional_permissions ?? []).filter(
        name => name !== 'downloads'
      ),
      permissions: [...new Set([...(manifest.permissions ?? []), 'downloads'])],
    })
  );
  await writeFile(join(directory, 'sw.js'), wrapper);

  return directory;
};

const probeSchema = z.object({
  bootedAt: z.number(),
  patched: z.boolean().optional(),
  /** The refusals this generation's patched read made; only the budgeted wrapper starts one. */
  refused: z.number().optional(),
});

type ProbeState = z.infer<typeof probeSchema>;

/** What one generation of the wrapper recorded about itself, or null before its script ran. */
const probeState = async (worker: Worker): Promise<ProbeState | null> => {
  const raw: unknown = await worker.evaluate('globalThis.__kiloRecordRetention ?? null');
  const parsed = probeSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
};

/** Every worker of one extension, including a stopped generation Playwright still holds. */
const workersOf = (context: BrowserContext, extensionId: string): Worker[] =>
  context.serviceWorkers().filter(worker => new URL(worker.url()).host === extensionId);

/** One worker's own record, or null when that generation is already gone. */
const generationOf = async (
  worker: Worker
): Promise<{ state: ProbeState; worker: Worker } | null> => {
  const state = await probeState(worker).catch(() => null);

  return state === null ? null : { state, worker };
};

/** The extension's worker whose record satisfies `matches`. */
const waitForGeneration = async (
  context: BrowserContext,
  extensionId: string,
  matches: (state: ProbeState) => boolean
): Promise<{ state: ProbeState; worker: Worker }> => {
  const found = Promise.withResolvers<{ state: ProbeState; worker: Worker }>();

  await expect
    .poll(
      async () => {
        const generations = await Promise.all(
          workersOf(context, extensionId).map(worker => generationOf(worker))
        );
        const match = generations.find(
          (entry): entry is { state: ProbeState; worker: Worker } =>
            entry !== null && matches(entry.state)
        );

        if (match !== undefined) {
          found.resolve(match);
        }

        return match !== undefined;
      },
      { timeout: 40_000 }
    )
    .toBe(true);

  return found.promise;
};

/** What `chrome.storage.session.get` answered inside one realm: a worker's patched realm, or a page's. */
const sessionReadSchema = z.object({
  error: z.string().optional(),
  kind: z.enum(['rejected', 'resolved']),
  value: z.unknown().optional(),
});

/**
 * Reads the record from inside the worker: the realm the product's own startup read runs in, where
 * the wrapper's patch is installed.
 */
const readInWorker = async (worker: Worker): Promise<z.infer<typeof sessionReadSchema>> => {
  const raw: unknown = await worker.evaluate(
    `chrome.storage.session.get(${JSON.stringify(HOLD_STATE_STORAGE_KEY)})
      .then(value => ({ kind: 'resolved', value }), error => ({ error: String(error), kind: 'rejected' }))`
  );

  return sessionReadSchema.parse(raw);
};

const tabSchema = z.object({
  page: z.string(),
  session: z.string(),
  step: z
    .object({
      argumentHash: z.string(),
      description: z.string(),
      noun: z.string(),
      origin: z.string(),
      session: z.string(),
      tabId: z.number(),
      toolName: z.string(),
    })
    .optional(),
  tabId: z.number(),
});

const targetSchema = z.object({ kind: z.string(), url: z.string().optional() });

const needSchema = z.object({
  expiresAt: z.number(),
  kind: z.string(),
  session: z.string(),
  tabId: z.number(),
  target: targetSchema,
});

const recordEntrySchema = z.object({
  need: needSchema.optional(),
  owed: z.array(z.record(z.string(), z.unknown())),
  tabs: z.array(tabSchema),
});

const recordSchema = z.record(z.string(), recordEntrySchema);

/** The record an extension page reads, parsed: the page's realm is never patched. */
const recordOnPage = async (page: Page): Promise<unknown> => {
  const raw: unknown = await page.evaluate(
    `chrome.storage.session.get(${JSON.stringify(HOLD_STATE_STORAGE_KEY)})
      .then(items => items[${JSON.stringify(HOLD_STATE_STORAGE_KEY)}] ?? null)`
  );

  return raw === null ? null : recordSchema.parse(raw);
};

/**
 * The record a page reads while it may hold a spent approval: `recordEntrySchema` names the armed need the existing
 * test writes, and a spent need carries the file it bought instead of an expiry, so this read keeps the fields the
 * spend assertions compare and tolerates the rest.
 */
const liveNeedSchema = z.looseObject({
  filename: z.string().optional(),
  itemId: z.number().optional(),
  kind: z.string(),
});

const liveRecordSchema = z.record(z.string(), z.looseObject({ need: liveNeedSchema.optional() }));

/** The record's raw value: the strict schema rejects a spent need, and an annotation keeps exactly what was stored. */
const rawRecordOnPage = (page: Page): Promise<unknown> =>
  page.evaluate(
    `chrome.storage.session.get(${JSON.stringify(HOLD_STATE_STORAGE_KEY)})
      .then(items => items[${JSON.stringify(HOLD_STATE_STORAGE_KEY)}] ?? null)`
  );

/** Each session's need as an extension page reads it: the value a spend is asserted on. */
const needsOnPage = async (page: Page): Promise<Record<string, z.infer<typeof liveNeedSchema>>> => {
  const raw = await rawRecordOnPage(page);

  if (raw === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(liveRecordSchema.parse(raw)).flatMap(([session, entry]) =>
      entry.need === undefined ? [] : [[session, entry.need]]
    )
  );
};

/** The record once it has settled: two reads a poll apart that agree are a value every write has landed. */
const settledRecord = async (page: Page): Promise<unknown> => {
  const read = async (): Promise<string> => JSON.stringify(await recordOnPage(page));
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

  throw new Error(
    'The hold record did not settle after 60 polls 50 ms apart: the value kept changing, so it was never read whole.'
  );
};

/** Writes the record from an extension page, the path a session's own facts reach the area by. */
const writeFromPage = async (page: Page, record: unknown): Promise<void> => {
  await page.evaluate(
    `chrome.storage.session.set(${JSON.stringify({ [HOLD_STATE_STORAGE_KEY]: record })})`
  );
};

/** One pause of the harness's own, used as the interval between two reads of one value. */
function after(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  setTimeout(resolve, milliseconds);

  return promise;
}

const downloadItemSchema = z.object({ filename: z.string(), id: z.number(), state: z.string() });

/** The browser's own download list, read from an extension page: what each item is and where it ended. */
const downloadItems = async (page: Page): Promise<z.infer<typeof downloadItemSchema>[]> => {
  const raw: unknown = await page.evaluate('chrome.downloads.search({})');

  return z.array(downloadItemSchema).parse(raw);
};

/**
 * The newest item the fixture's attachment became, once the browser reports a state it will not
 * leave. The guarded navigate of step 2 left an earlier item for the same file behind, and this
 * step drove the one that matters, so the newest match is the one read.
 */
const settledItem = async (page: Page): Promise<z.infer<typeof downloadItemSchema> | undefined> => {
  let found: z.infer<typeof downloadItemSchema> | undefined = undefined;

  await expect
    .poll(
      async () => {
        const items = await downloadItems(page);

        found = items.findLast(item => item.filename.endsWith(DOWNLOAD_FILENAME));

        return found?.state ?? 'absent';
      },
      { timeout: 30_000 }
    )
    .toMatch(/^(?:complete|interrupted)$/u);

  return found;
};

interface CdpTargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

/** A record with one session, one tab and one armed approval: exactly what `stateSchema` accepts. */
const seedRecordFor = (url: string, tabId: number, session = 'session-1') => ({
  [session]: {
    need: {
      expiresAt: Date.now() + 600_000,
      kind: 'armed',
      session,
      tabId,
      target: { kind: 'url', url: `${url}${DOWNLOAD_PATH}` },
    },
    owed: [],
    tabs: [{ page: `${url}/page`, session, tabId }],
  },
});

/** Nothing landed: no finished file, and no temp file still growing. */
const expectNothingSaved = async (downloadsPath: string): Promise<void> => {
  await expect.poll(() => downloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
  await expect.poll(() => tempDownloadFiles(downloadsPath), { timeout: 20_000 }).toStrictEqual([]);
};

test('the download-hold record stays as written across a worker restart that gets no answer, and the extension still serves', async () => {
  test.setTimeout(300_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const extensionDirectory = await writeRecordRetentionExtension();
  const launch = await launchRealDownloadBrowser({ extensionPath: extensionDirectory });
  const { context, downloadsPath, extensionId } = launch;

  await mockKiloApi(context, {});
  // The settings panel asks for the optional download permission while it enables local agents; a
  // Real prompt cannot be answered here, and an unanswered request leaves the worker's host disabled,
  // Which drops the pairing a CLI link opens.
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await agentPage.goto(`${fixture.url}/page`);

    const first = await waitForGeneration(context, extensionId, () => true);
    const seeded = seedRecordFor(fixture.url, 9);

    // 1. An extension page writes the record. The page's own realm is never patched, so the record
    // Is exactly what the spec wrote, and the boot read that will replace it has not happened yet.
    await writeFromPage(sidePanel, seeded);

    const written = await settledRecord(sidePanel);

    expect(recordSchema.parse(written)).toStrictEqual(seeded);

    // 2. A live agent session shares the seeded tab's page and makes one guarded navigate to an
    // Attachment: the session's own tab and its own approval reach the worker's live hold, which is
    // What has to keep answering once the record's read starts failing.
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Record retention session',
    });

    const guarded = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DOWNLOAD_PATH}` },
      [
        { class: 'act', origin: fixture.url },
        { class: 'navigate', origin: fixture.url },
        { class: 'read', origin: fixture.url },
      ]
    );

    expect(guarded).toMatchObject({
      afterAction: true,
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      kind: 'error',
    });
    expect(guarded.kind === 'error' ? guarded.stepToken : undefined).toEqual(expect.any(String));
    // The call's own request reached the fixture, and the hold stopped the item it would have written.
    expect(fixture.hits()).toBeGreaterThan(0);
    await expectNothingSaved(downloadsPath);

    // 3. The worker is restarted with no page reload: its own target is closed over CDP and the
    // Extension is woken from the panel, so the next generation boots against the same refusing read.
    const beforeRestart = await settledRecord(sidePanel);
    const browserCdp = await launch.browser.newBrowserCDPSession();

    await browserCdp.send('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    });

    const targets = (await browserCdp.send('Target.getTargets')) as {
      targetInfos: CdpTargetInfo[];
    };
    const workerTarget = targets.targetInfos.find(
      target => target.type === 'service_worker' && target.url.includes(extensionId)
    );

    if (workerTarget === undefined) {
      throw new Error('the browser reported no service worker for the extension under test');
    }

    const closed = await browserCdp.send('Target.closeTarget', { targetId: workerTarget.targetId });

    // The auto-attach above would hold every new page target for the debugger; nothing else needs it.
    await browserCdp
      .send('Target.setAutoAttach', {
        autoAttach: false,
        flatten: true,
        waitForDebuggerOnStart: false,
      })
      .catch(() => null);
    await browserCdp.detach().catch(() => null);

    // The panel's own message is what starts the next generation; nothing answers it, which is fine.
    const wake: unknown = await sidePanel.evaluate(
      `chrome.runtime.sendMessage({ probe: 'wake' })
        .then(() => ({ kind: 'answered' }), error => ({ error: String(error), kind: 'rejected' }))`
    );

    const second = await waitForGeneration(
      context,
      extensionId,
      state => state.bootedAt !== first.state.bootedAt
    );

    // 4. The new generation's own read rejects, so this boot ran against an area that will not
    // Answer, and nothing in it could have written over the record.
    const workerRead = await readInWorker(second.worker);

    expect(second.state.patched).toBe(true);
    expect(workerRead).toMatchObject({ kind: 'rejected' });

    // 5. The record an extension page reads back is the seeded one, untouched: the session, its tab
    // And its approval are all still there, which is what the next boot reads.
    const afterRestart = await settledRecord(sidePanel);

    // 6. The extension still serves a download after the restart: the hold decides with the live
    // Mirror (nothing is restored without a record) and the file's own item settles in the browser.
    await agentPage.goto(`${fixture.url}${DOWNLOAD_PATH}`).catch(() => null);

    const item = await settledItem(sidePanel);
    const items = await downloadItems(sidePanel);
    const folder = await downloadFiles(downloadsPath);

    // 7. That download stored nothing either: the record is still the seeded one.
    const afterDownload = await settledRecord(sidePanel);

    test
      .info()
      .annotations.push(
        { description: JSON.stringify(seeded), type: 'seeded-record' },
        { description: JSON.stringify(written), type: 'record-after-write' },
        { description: JSON.stringify(beforeRestart), type: 'record-before-restart' },
        { description: JSON.stringify(first.state), type: 'first-generation' },
        { description: JSON.stringify(second.state), type: 'second-generation' },
        { description: JSON.stringify(closed), type: 'worker-close' },
        { description: JSON.stringify(wake), type: 'wake' },
        { description: JSON.stringify(workerRead), type: 'worker-read' },
        { description: JSON.stringify(afterRestart), type: 'record-after-restart' },
        { description: JSON.stringify(item ?? null), type: 'post-restart-download' },
        { description: JSON.stringify(items), type: 'download-items' },
        { description: JSON.stringify({ hits: fixture.hits() }), type: 'guarded-navigate' },
        { description: JSON.stringify(folder), type: 'post-restart-folder' },
        { description: JSON.stringify(afterDownload), type: 'record-after-download' }
      );

    expect(recordSchema.parse(afterRestart)).toStrictEqual(seeded);
    expect(recordSchema.parse(afterDownload)).toStrictEqual(seeded);

    // The unread mirror answers from the live hold, which owns no tab here: the file is not held,
    // So the browser writes it under the browser's own name and nothing is left growing.
    expect(item?.state).toBe('complete');
    expect(await tempDownloadFiles(downloadsPath)).toStrictEqual([]);
    expect(folder).toStrictEqual([DOWNLOAD_FILENAME]);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
    await rm(extensionDirectory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

/*
 * The record keeps the approval a file spent as `spent`, and a worker whose own read got no answer stores nothing —
 * so a spend makes one read of its own, and the approval it spent is kept with the record it belongs to. This spec
 * drives that on the real build.
 *
 * The wrapper refuses the record's read only as often as `chrome.storage.local` says, so the new generation's boot
 * read is refused and the spend's own read is answered. The stored record is an armed approval for the session that
 * spends it — keyed by the session handle, which is the key every write of the record uses — and the spec asserts
 * that the same key reads back `spent`, which is the value a later worker reads for that session.
 */
test('a spend in a worker that got no answer keeps the spent approval with the record', async () => {
  test.setTimeout(300_000);
  const fixture = await startDownloadFixture();
  const hub = await startFakeHub();
  const extensionDirectory = await writeRecordRetentionExtension(WRAPPER_SERVICE_WORKER_BUDGETED);
  const launch = await launchRealDownloadBrowser({ extensionPath: extensionDirectory });
  const { context, downloadsPath, extensionId } = launch;

  await mockKiloApi(context, {});
  await context.addInitScript({
    content:
      "Object.defineProperty(chrome.permissions, 'request', { value: () => Promise.resolve(true) });",
  });

  try {
    const sidePanel = await context.newPage();
    const agentPage = await context.newPage();

    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await agentPage.goto(`${fixture.url}/page`);

    const first = await waitForGeneration(context, extensionId, () => true);

    // 1. The next generation's boot read is the one refusal this budget pays for. Nothing else in this spec asks
    // The record's key of `storage.session`, and `readInWorker` is never called here: it would spend the budget.
    await sidePanel.evaluate('chrome.storage.local.set({ kiloE2eRefusalBudget: 1 })');

    // 2. The worker is restarted with no page reload: its own target is closed over CDP and the extension is woken
    // From the panel, so the next generation boots against a read the budget refuses once.
    const browserCdp = await launch.browser.newBrowserCDPSession();

    await browserCdp.send('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    });

    const targets = (await browserCdp.send('Target.getTargets')) as {
      targetInfos: CdpTargetInfo[];
    };
    const workerTarget = targets.targetInfos.find(
      target => target.type === 'service_worker' && target.url.includes(extensionId)
    );

    if (workerTarget === undefined) {
      throw new Error('the browser reported no service worker for the extension under test');
    }

    const closed = await browserCdp.send('Target.closeTarget', { targetId: workerTarget.targetId });

    // The auto-attach above would hold every new page target for the debugger; nothing else needs it.
    await browserCdp
      .send('Target.setAutoAttach', {
        autoAttach: false,
        flatten: true,
        waitForDebuggerOnStart: false,
      })
      .catch(() => null);
    await browserCdp.detach().catch(() => null);

    // The panel's own message is what starts the next generation; nothing answers it, which is fine.
    const wake: unknown = await sidePanel.evaluate(
      `chrome.runtime.sendMessage({ probe: 'wake' })
        .then(() => ({ kind: 'answered' }), error => ({ error: String(error), kind: 'rejected' }))`
    );

    const second = await waitForGeneration(
      context,
      extensionId,
      state => state.bootedAt !== first.state.bootedAt
    );

    // 3. That generation refused the record's read itself, so it restored nothing and stores nothing until the
    // Spend asks for the record it is about to change. `refused` counts only after the patched read's own two
    // `chrome.storage.local` round trips, so it is polled rather than read once from the restart snapshot.
    expect(second.state.patched).toBe(true);
    await expect
      .poll(
        async () => {
          const live = await probeState(second.worker).catch(() => null);

          return live === null ? 0 : (live.refused ?? 0);
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThanOrEqual(1);

    // 4. The session the spend belongs to. The record is keyed by the session handle, so the armed approval stored
    // Below is the same key the approved file spends.
    const session = await openPairedAgentSession({
      beforeShare: async () => {
        await activateTab(sidePanel, `${fixture.url}/page`);
      },
      context,
      extensionId,
      hub,
      sidePanel,
      title: 'Spend retention session',
    });
    const grants = [
      { class: 'act', origin: fixture.url },
      { class: 'navigate', origin: fixture.url },
      { class: 'read', origin: fixture.url },
    ];

    const guarded = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DOWNLOAD_PATH}` },
      grants
    );

    expect(guarded).toMatchObject({
      afterAction: true,
      code: LOCAL_AGENT_ERROR_CODES.needsPermission,
      kind: 'error',
    });
    expect(guarded.kind === 'error' ? guarded.stepToken : undefined).toEqual(expect.any(String));
    // The call's own request reached the fixture, and the hold stopped the item it would have written.
    expect(fixture.hits()).toBeGreaterThan(0);
    await expectNothingSaved(downloadsPath);

    // 5. The stored record still says `armed` for this session, which is what a worker that stored nothing leaves
    // Behind. The approved file spends that approval, and the spend's own read is the only thing that can store it.
    const armed = seedRecordFor(fixture.url, session.tabId, session.sessionHandle);

    await writeFromPage(sidePanel, armed);

    const beforeSpend = await settledRecord(sidePanel);

    expect(recordSchema.parse(beforeSpend)).toStrictEqual(armed);

    const approved = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}${DOWNLOAD_PATH}` },
      grants,
      [guarded.kind === 'error' ? (guarded.stepToken ?? '') : '']
    );

    expect(approved).toMatchObject({ isError: false, kind: 'result' });

    // 6. The spend's read answered, so the worker merged the record under its own mirror — where the approval is
    // Spent — and stored it: the key reads back `spent`, which is the value a later worker reads for that session.
    await expect
      .poll(
        async () => {
          const needs = await needsOnPage(sidePanel);

          return needs[session.sessionHandle]?.kind ?? 'absent';
        },
        { timeout: 30_000 }
      )
      .toBe('spent');

    const needs = await needsOnPage(sidePanel);
    const afterSpend = await rawRecordOnPage(sidePanel);
    const items = await downloadItems(sidePanel);
    const folder = await downloadFiles(downloadsPath);
    const temp = await tempDownloadFiles(downloadsPath);

    test
      .info()
      .annotations.push(
        { description: JSON.stringify(armed), type: 'seeded-armed-record' },
        { description: JSON.stringify(first.state), type: 'first-generation' },
        { description: JSON.stringify(second.state), type: 'second-generation' },
        { description: JSON.stringify(closed), type: 'worker-close' },
        { description: JSON.stringify(wake), type: 'wake' },
        { description: JSON.stringify({ hits: fixture.hits() }), type: 'guarded-navigate' },
        { description: JSON.stringify(beforeSpend), type: 'record-before-spend' },
        { description: JSON.stringify(approved), type: 'approved-download' },
        { description: JSON.stringify(afterSpend), type: 'record-after-spend' },
        { description: JSON.stringify(items), type: 'download-items' },
        { description: JSON.stringify(folder), type: 'folder-after-spend' }
      );

    expect(needs[session.sessionHandle]?.kind).toBe('spent');
    // The approval bought its one file, and nothing is left growing behind it.
    expect(folder).toContain(DOWNLOAD_FILENAME);
    expect(temp).toStrictEqual([]);
  } finally {
    await launch.close();
    await hub.close();
    await fixture.close();
    await rm(extensionDirectory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});
