/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import {
  createNewConversation,
  delayConversationStoreHydration,
  getActiveConversationSelectedTabId,
  getSelectedTargetTabLabel,
  getTargetTabOptionCount,
  getTargetTabOptionLabels,
  releaseConversationStoreHydrationUntilReady,
  requireSelectedTargetTabId,
  requireTwoOptionLabels,
  waitForActiveConversationSelectedTabId,
} from './tab-selection-e2e-helpers';

const openAuthedSidePanel = async (context: BrowserContext, extensionId: string): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  await expect(sidePanel.getByLabel('New conversation')).toBeEnabled();

  return sidePanel;
};

const waitForSettledTargetLabel = async (sidePanel: Page): Promise<string> => {
  await expect.poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 }).not.toBe('');

  return getSelectedTargetTabLabel(sidePanel);
};

/**
 * Freeze first conversation on `freezeTitle` (only that fixture tab is open),
 * open two candidate tabs, then activate the candidate that differs from both
 * the frozen label and the runtime first-listed label. Three-tab geometry
 * always yields a non-vacuous activation target for every getTargets() order.
 * Fresh browser context per call so legs are independent.
 */
const runCreatePathActiveDefaultLeg = async ({
  candidateTitles,
  freezeTitle,
}: {
  candidateTitles: readonly [string, string];
  freezeTitle: string;
}): Promise<void> => {
  const freezeFixture = await startFixtureServer({ title: freezeTitle });
  const candidateFixtures = await Promise.all(
    candidateTitles.map(title => startFixtureServer({ title }))
  );
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const freezePage = await context.newPage();
    await freezePage.goto(freezeFixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    const frozenFirstLabel = await waitForSettledTargetLabel(sidePanel);
    const optionLabelsBefore = await getTargetTabOptionLabels(sidePanel);
    const [firstListedBefore] = optionLabelsBefore;

    expect(frozenFirstLabel).toBe(freezeTitle);
    expect(firstListedBefore).toBe(freezeTitle);

    const pagesByTitle = new Map<string, Page>([[freezeTitle, freezePage]]);
    const candidatePages = await Promise.all(
      candidateTitles.map(async (title, index) => {
        const page = await context.newPage();
        await page.goto(candidateFixtures[index]!.url);

        return [title, page] as const;
      })
    );

    for (const [title, page] of candidatePages) {
      pagesByTitle.set(title, page);
    }

    await expect.poll(() => getTargetTabOptionCount(sidePanel), { timeout: 10_000 }).toBe(3);

    const optionLabels = await getTargetTabOptionLabels(sidePanel);
    const [firstListed] = optionLabels;
    expect(firstListed).toBeDefined();
    expect(optionLabels).toEqual(
      expect.arrayContaining([freezeTitle, candidateTitles[0], candidateTitles[1]])
    );

    // Three tabs: at least one label differs from both frozen and first-listed, so
    // Both inheritance and first-listed regression guards always have teeth.
    const activateTitle = candidateTitles.find(
      title => title !== frozenFirstLabel && title !== firstListed
    );

    if (activateTitle === undefined) {
      throw new Error(
        `No non-vacuous activation target among ${candidateTitles.join(', ')} ` +
          `(frozen=${frozenFirstLabel}, firstListed=${firstListed}).`
      );
    }

    const activatePage = pagesByTitle.get(activateTitle);

    if (activatePage === undefined) {
      throw new Error(`Missing page for activation target ${activateTitle}`);
    }

    await activatePage.bringToFront();
    await createNewConversation(sidePanel);

    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe(activateTitle);

    const seededLabel = await getSelectedTargetTabLabel(sidePanel);
    expect(seededLabel).toBe(activateTitle);
    expect(seededLabel).not.toBe(frozenFirstLabel);
    expect(seededLabel).not.toBe(firstListed);
  } finally {
    await context.close();
    await freezeFixture.close();
    await Promise.all(candidateFixtures.map(fixture => fixture.close()));
    await rm(userDataDir, { force: true, recursive: true });
  }
};

test('create-path defaults to the activated content tab for each freeze fixture', async () => {
  // Leg 1: freeze Alpha; candidates Beta/Gamma — activate the non-vacuous one.
  await runCreatePathActiveDefaultLeg({
    candidateTitles: ['Default tab Beta', 'Default tab Gamma'],
    freezeTitle: 'Default tab Alpha',
  });
  // Leg 2: freeze Beta; candidates Alpha/Gamma (covers the other freeze fixture).
  await runCreatePathActiveDefaultLeg({
    candidateTitles: ['Default tab Alpha', 'Default tab Gamma'],
    freezeTitle: 'Default tab Beta',
  });
});

test('manual target-tab pick survives poll cycles', async () => {
  const firstFixture = await startFixtureServer({ title: 'Persist tab Alpha' });
  const secondFixture = await startFixtureServer({ title: 'Persist tab Beta' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const pageAlpha = await context.newPage();
    await pageAlpha.goto(firstFixture.url);
    const pageBeta = await context.newPage();
    await pageBeta.goto(secondFixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await waitForSettledTargetLabel(sidePanel);

    const { otherLabel } = await requireTwoOptionLabels(sidePanel);

    await pageAlpha.bringToFront();
    await createNewConversation(sidePanel);
    await waitForSettledTargetLabel(sidePanel);

    await sidePanel.getByLabel('Target tab').selectOption({ label: otherLabel });
    await expect.poll(() => getSelectedTargetTabLabel(sidePanel)).toBe(otherLabel);

    // R2: selection stays across at least one full 2s poll cycle (wall time >2s).
    const startedAt = Date.now();
    const labelsSeen: string[] = [];
    await expect
      .poll(async () => {
        labelsSeen.push(await getSelectedTargetTabLabel(sidePanel));

        return Date.now() - startedAt;
      })
      .toBeGreaterThan(2000);
    expect(labelsSeen.length).toBeGreaterThan(0);
    expect(new Set(labelsSeen)).toEqual(new Set([otherLabel]));
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('single fixture tab is the first-conversation default', async () => {
  const fixture = await startFixtureServer({ title: 'Only fixture tab' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);

    // Harness panel tab is active/non-inspectable; fallback is the sole fixture tab.
    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe('Only fixture tab');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('hydration race preserves a manual pick and freeze survives reload', async () => {
  test.setTimeout(60_000);

  const firstFixture = await startFixtureServer({ title: 'Hydration tab Alpha' });
  const secondFixture = await startFixtureServer({ title: 'Hydration tab Beta' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const pageAlpha = await context.newPage();
    await pageAlpha.goto(firstFixture.url);
    const pageBeta = await context.newPage();
    await pageBeta.goto(secondFixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await waitForSettledTargetLabel(sidePanel);

    const { otherLabel: pickedLabel } = await requireTwoOptionLabels(sidePanel);

    await sidePanel.getByLabel('Target tab').selectOption({ label: pickedLabel });
    await expect.poll(() => getSelectedTargetTabLabel(sidePanel)).toBe(pickedLabel);

    const pickedTabId = await requireSelectedTargetTabId(sidePanel);

    // PRECONDITION: pick must be persisted before reload/hydration delay.
    await waitForActiveConversationSelectedTabId(sidePanel, pickedTabId);

    await delayConversationStoreHydration(sidePanel);
    await sidePanel.reload();

    // Avoid storage reads while hydration is held — they match the delay filter and
    // Consume the one-shot hold (deadlock with app hydration). Write-gate sanity:
    // Storage writes are gated on isLoaded and are proven post-release below.
    await releaseConversationStoreHydrationUntilReady(sidePanel);

    // A7(b) POST-RELEASE: selector and storage still show the picked tab.
    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe(pickedLabel);
    await expect
      .poll(() => getActiveConversationSelectedTabId(sidePanel), { timeout: 10_000 })
      .toBe(pickedTabId);

    // Freeze leg: reload with a DIFFERENT content tab active. Init script re-arms hold.
    const pagesByLabel = new Map([
      ['Hydration tab Alpha', pageAlpha],
      ['Hydration tab Beta', pageBeta],
    ]);
    const otherLabel =
      pickedLabel === 'Hydration tab Alpha' ? 'Hydration tab Beta' : 'Hydration tab Alpha';
    const otherPage = pagesByLabel.get(otherLabel);

    if (otherPage === undefined) {
      throw new Error(`Missing page for ${otherLabel}`);
    }

    await otherPage.bringToFront();
    await sidePanel.reload();
    await releaseConversationStoreHydrationUntilReady(sidePanel);

    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe(pickedLabel);
    await expect
      .poll(() => getActiveConversationSelectedTabId(sidePanel), { timeout: 10_000 })
      .toBe(pickedTabId);
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('empty inspectable list does not wipe a stored selectedTabId', async () => {
  test.setTimeout(45_000);

  const firstFixture = await startFixtureServer({ title: 'Wipe-guard tab Alpha' });
  const secondFixture = await startFixtureServer({ title: 'Wipe-guard tab Beta' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const pageAlpha = await context.newPage();
    await pageAlpha.goto(firstFixture.url);
    const pageBeta = await context.newPage();
    await pageBeta.goto(secondFixture.url);

    const sidePanel = await openAuthedSidePanel(context, extensionId);
    await waitForSettledTargetLabel(sidePanel);

    const { otherLabel: pickedLabel } = await requireTwoOptionLabels(sidePanel);

    await sidePanel.getByLabel('Target tab').selectOption({ label: pickedLabel });
    await expect.poll(() => getSelectedTargetTabLabel(sidePanel)).toBe(pickedLabel);

    const pickedTabId = await requireSelectedTargetTabId(sidePanel);

    await waitForActiveConversationSelectedTabId(sidePanel, pickedTabId);

    await pageAlpha.close();
    await pageBeta.close();

    // Reach empty UI first, then hold across >4s (two poll cycles) via storage polling.
    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe('No tab selected');

    const startedAt = Date.now();
    const labelsSeen: string[] = [];
    const storedIdsSeen: (number | undefined)[] = [];
    await expect
      .poll(
        async () => {
          labelsSeen.push(await getSelectedTargetTabLabel(sidePanel));
          storedIdsSeen.push(await getActiveConversationSelectedTabId(sidePanel));

          return Date.now() - startedAt;
        },
        { timeout: 12_000 }
      )
      .toBeGreaterThan(4000);

    // A7(a): stored pick must survive empty list; selector shows empty state.
    expect(new Set(labelsSeen)).toEqual(new Set(['No tab selected']));
    expect(new Set(storedIdsSeen)).toEqual(new Set([pickedTabId]));
    await expect.poll(() => getSelectedTargetTabLabel(sidePanel)).toBe('No tab selected');
    await expect.poll(() => getActiveConversationSelectedTabId(sidePanel)).toBe(pickedTabId);
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
