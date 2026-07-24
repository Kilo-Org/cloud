/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  readExtensionLocalStorage,
  readExtensionSyncStorage,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { findCapturedEvent, findCapturedEvents } from './posthog-fixture';
import type { NormalizedPosthogEvent } from './posthog-fixture';

const ANALYTICS_OPT_OUT_KEY = 'analyticsOptOut';
const SEEDED_EMAIL = 'user@kilo.ai';
const PRODUCT_EVENTS = [
  '$identify',
  'extension_signed_in',
  'extension_signed_out',
  'message_sent',
  'conversation_created',
] as const;

const openSignedInSidePanel = async (
  context: BrowserContext,
  extensionId: string
): Promise<Page> => {
  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();
  await expect(sidePanel.getByLabel('Settings')).toBeVisible();
  return sidePanel;
};

const waitForEvent = async (
  posthogRequests: readonly NormalizedPosthogEvent[],
  eventName: string
): Promise<NormalizedPosthogEvent> => {
  await expect
    .poll(() => findCapturedEvent(posthogRequests, eventName), { timeout: 10_000 })
    .toBeTruthy();
  const event = findCapturedEvent(posthogRequests, eventName);
  if (event === undefined) {
    throw new Error(`Expected ${eventName} to be recorded.`);
  }
  return event;
};

const waitForIdentify = async (
  posthogRequests: readonly NormalizedPosthogEvent[],
  options?: { baseline?: number; email?: string }
): Promise<NormalizedPosthogEvent> => {
  const baseline = options?.baseline ?? 0;
  const email = options?.email ?? SEEDED_EMAIL;
  await expect
    .poll(
      () =>
        posthogRequests
          .slice(baseline)
          .find(event => event.event === '$identify' && event.distinctId === email),
      { timeout: 10_000 }
    )
    .toBeTruthy();
  const event = posthogRequests
    .slice(baseline)
    .find(entry => entry.event === '$identify' && entry.distinctId === email);
  if (event === undefined) {
    throw new Error(`Expected $identify for ${email} after baseline ${baseline}.`);
  }
  return event;
};

const identifiedEventsIn = (events: readonly NormalizedPosthogEvent[]): NormalizedPosthogEvent[] =>
  events.filter(event => typeof event.distinctId === 'string' && event.distinctId.length > 0);

const productEventsIn = (events: readonly NormalizedPosthogEvent[]): NormalizedPosthogEvent[] =>
  events.filter(event => (PRODUCT_EVENTS as readonly string[]).includes(event.event));

const analyticsSwitch = (sidePanel: Page) =>
  sidePanel.getByRole('switch', { name: 'Share usage analytics' });

test('analytics identify and sign-in event fire on signed-in session start', async () => {
  const { context, extensionId, posthogFlagsOrDecideHits, posthogRequests, userDataDir } =
    await launchExtensionContext();

  try {
    await mockKiloApi(context);
    await openSignedInSidePanel(context, extensionId);

    const identify = await waitForIdentify(posthogRequests);
    expect(identify.distinctId).toBe(SEEDED_EMAIL);

    const signedIn = await waitForEvent(posthogRequests, 'extension_signed_in');
    expect(signedIn.properties).toMatchObject({
      platform: 'extension',
      source: 'stored_session',
    });

    expect(posthogFlagsOrDecideHits).toEqual([]);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('analytics sign-out event fires before reset on sign out', async () => {
  const { context, extensionId, posthogRequests, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openSignedInSidePanel(context, extensionId);
    await waitForIdentify(posthogRequests);
    await waitForEvent(posthogRequests, 'extension_signed_in');

    await sidePanel.getByLabel('Settings').click();
    const baseline = posthogRequests.length;

    await sidePanel.getByRole('button', { name: 'Sign out' }).click();

    await expect
      .poll(
        () => findCapturedEvents(posthogRequests.slice(baseline), 'extension_signed_out').length,
        { timeout: 10_000 }
      )
      .toBe(1);

    const signedOut = findCapturedEvent(posthogRequests.slice(baseline), 'extension_signed_out');
    expect(signedOut?.properties).toMatchObject({ reason: 'explicit' });

    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();

    const postBaselineIdentified = identifiedEventsIn(posthogRequests.slice(baseline));
    expect(postBaselineIdentified).toHaveLength(1);
    expect(postBaselineIdentified[0]?.event).toBe('extension_signed_out');
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('analytics opt-out toggle persists across side panel reloads', async () => {
  const { context, extensionId, posthogRequests, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openSignedInSidePanel(context, extensionId);
    await waitForIdentify(posthogRequests);
    await waitForEvent(posthogRequests, 'extension_signed_in');

    await sidePanel.getByLabel('Settings').click();
    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'true');

    await analyticsSwitch(sidePanel).click();
    const optOutBaseline = posthogRequests.length;

    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);
    expect(productEventsIn(posthogRequests.slice(optOutBaseline))).toHaveLength(0);

    const afterReloadBaseline = posthogRequests.length;
    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await sidePanel.getByLabel('Settings').click();
    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);
    expect(productEventsIn(posthogRequests.slice(afterReloadBaseline))).toHaveLength(0);

    await sidePanel.getByRole('button', { name: 'Sign out' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect
      .poll(() => readExtensionLocalStorage(sidePanel, 'kiloAuth'), { timeout: 5000 })
      .toBeUndefined();
    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);

    await seedExtensionAuth(sidePanel);
    const reseedBaseline = posthogRequests.length;
    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await sidePanel.getByLabel('Settings').click();
    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);
    expect(productEventsIn(posthogRequests.slice(reseedBaseline))).toHaveLength(0);

    const toggleOnBaseline = posthogRequests.length;
    await analyticsSwitch(sidePanel).click();
    await waitForIdentify(posthogRequests, { baseline: toggleOnBaseline, email: SEEDED_EMAIL });
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('analytics captures message sent and user-created conversation events', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, posthogRequests, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Analytics reply.' } }] }],
      toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await openSignedInSidePanel(context, extensionId);
    await waitForIdentify(posthogRequests);

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    await expect(sidePanel.getByLabel('Model')).not.toContainText('Loading');

    const conversationCreatedAtOpen = findCapturedEvents(
      posthogRequests,
      'conversation_created'
    ).length;
    expect(conversationCreatedAtOpen).toBe(0);

    const messageInput = sidePanel.getByLabel('Message agent');
    await messageInput.fill('Hello from analytics e2e');
    await messageInput.press('Enter');

    const messageSent = await waitForEvent(posthogRequests, 'message_sent');
    expect(messageSent.properties).toMatchObject({ mode: 'safe' });

    await sidePanel.getByLabel('New conversation').click();

    await expect
      .poll(() => findCapturedEvents(posthogRequests, 'conversation_created').length, {
        timeout: 10_000,
      })
      .toBe(conversationCreatedAtOpen + 1);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('analytics sign-out event fires with expired reason on mid-session expiry', async () => {
  const { context, extensionId, posthogRequests, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    const sidePanel = await openSignedInSidePanel(context, extensionId);
    await waitForIdentify(posthogRequests);
    await waitForEvent(posthogRequests, 'extension_signed_in');

    const baseline = posthogRequests.length;

    // Registered after mockKiloApi so this handler takes precedence.
    await context.route('https://app.kilo.ai/api/user', route =>
      route.fulfill({
        json: { error: 'unauthorized' },
        status: 401,
      })
    );

    await context.setOffline(true);
    await context.setOffline(false);

    await expect
      .poll(
        () => findCapturedEvents(posthogRequests.slice(baseline), 'extension_signed_out').length,
        { timeout: 15_000 }
      )
      .toBe(1);

    const signedOut = findCapturedEvent(posthogRequests.slice(baseline), 'extension_signed_out');
    expect(signedOut?.properties).toMatchObject({ reason: 'expired' });

    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();

    const postBaselineIdentified = identifiedEventsIn(posthogRequests.slice(baseline));
    expect(postBaselineIdentified).toHaveLength(1);
    expect(postBaselineIdentified[0]?.event).toBe('extension_signed_out');
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
