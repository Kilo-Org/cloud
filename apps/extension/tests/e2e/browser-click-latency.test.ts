/* eslint-disable import/no-nodejs-modules, max-lines -- the probe drives a real hub session and prints the medians it measured */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { startDownloadFixture } from './download-fixture';
import { launchExtensionContext } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { startFakeHub } from './local-agents-hub-fixture';
import { activateTab, openPairedAgentSession } from './local-agents-fixture';
import type { LocalAgentToolResponse } from './local-agents-fixture';

/*
 * The click-latency probe: a mixed navigate/snapshot/click/screenshot cycle
 * with no download anywhere in it. Every step is timed around the agent call,
 * and the medians are printed, so a change to the download guard's waiting
 * budget is visible as a click number rather than as a guess.
 *
 * The click is the step the guard charges for: a call that can start a download
 * pays the guard's own window before it answers. The snapshot and the
 * screenshot are the controls — they are not download-capable, so a rise in the
 * click alone is the guard and not the machine.
 */

const CYCLES = 20;
/** A mixed cycle's click may not pay more than this: the guard's start grace plus one search. */
const CLICK_BUDGET_MS = 120;

const median = (values: readonly number[]): number => {
  const sorted = [...values].toSorted((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const grant = (origin: string) => [
  { class: 'act', origin },
  { class: 'navigate', origin },
  { class: 'read', origin },
];

/** The text a call answered with, or the error it reported: one shape for the probe's own logging. */
const textOf = (answer: LocalAgentToolResponse): string =>
  answer.kind === 'result'
    ? answer.text
    : `error ${String(answer.code ?? '')} ${answer.message ?? ''}`;

/** The plain button's ref from a snapshot, failing loudly when the page did not render it. */
const plainButtonRef = (snapshotText: string): string => {
  const ref = /button "Plain button" \[ref=(e\d+)\]/u.exec(snapshotText)?.[1];

  if (ref === undefined) {
    throw new Error(`no plain button in the snapshot:\n${snapshotText.slice(0, 2000)}`);
  }

  return ref;
};

test('the mixed navigate, snapshot, click and screenshot cycle stays inside the click budget', async () => {
  test.setTimeout(180_000);
  const fixture = await startDownloadFixture();
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
      title: 'Latency probe session',
    });

    const navigated = await session.callTool(
      'browser_navigate',
      { url: `${fixture.url}/page` },
      grants
    );

    expect(navigated).toMatchObject({ isError: false, kind: 'result' });

    /** One call, timed end to end. */
    const timed = async (
      name: string,
      args: Record<string, unknown>
    ): Promise<{ readonly ms: number; readonly text: string }> => {
      const startedAt = performance.now();
      const answer = await session.callTool(name, args, grants);
      const ms = performance.now() - startedAt;

      return { ms, text: textOf(answer) };
    };

    const clicks: number[] = [];
    const snapshots: number[] = [];
    const screenshots: number[] = [];
    const navigates: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      // eslint-disable-next-line no-await-in-loop -- the cycles are the measurement, one after the other
      const navigate = await timed('browser_navigate', { url: `${fixture.url}/page` });

      navigates.push(navigate.ms);
      // eslint-disable-next-line no-await-in-loop -- see above
      const snapshot = await timed('browser_snapshot', {});

      snapshots.push(snapshot.ms);
      const ref = plainButtonRef(snapshot.text);

      // eslint-disable-next-line no-await-in-loop -- see above
      const click = await timed('browser_click', { element: 'Plain button', target: ref });

      expect(click.text).toContain('Clicked');
      clicks.push(click.ms);
      // eslint-disable-next-line no-await-in-loop -- see above
      const screenshot = await timed('browser_take_screenshot', {});

      screenshots.push(screenshot.ms);
    }

    const clickMedian = median(clicks);

    console.log(
      `latency probe (${String(CYCLES)} cycles): click median ${clickMedian.toFixed(0)} ms, ` +
        `snapshot median ${median(snapshots).toFixed(0)} ms, ` +
        `screenshot median ${median(screenshots).toFixed(0)} ms, ` +
        `navigate median ${median(navigates).toFixed(0)} ms`
    );
    console.log(`click samples: ${clicks.map(value => value.toFixed(0)).join(' ')}`);

    expect(clickMedian).toBeLessThan(CLICK_BUDGET_MS);
  } finally {
    await context.close();
    await hub.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
