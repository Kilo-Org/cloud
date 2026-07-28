/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines */
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

/** Brand accent track (#f7f586) and knob (#1f1f1f); off track is surface-overlay (#333333). */
const BRAND_PRIMARY_RGB = { blue: 134, green: 245, red: 247 } as const;
const BRAND_PRIMARY_FOREGROUND_RGB = { blue: 31, green: 31, red: 31 } as const;
const SURFACE_OVERLAY_RGB = { blue: 51, green: 51, red: 51 } as const;

interface RgbaChannels {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

// Inline copy of design-tokens.test.ts helpers (A3.2b — do not extract a shared module).
const parseRgba = (value: string): RgbaChannels => {
  const commaMatch = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/u
  );

  if (commaMatch !== null) {
    const [, redRaw, greenRaw, blueRaw, alphaRaw] = commaMatch;

    return {
      alpha: alphaRaw === undefined ? 1 : Number.parseFloat(alphaRaw),
      blue: Number.parseFloat(blueRaw ?? '0'),
      green: Number.parseFloat(greenRaw ?? '0'),
      red: Number.parseFloat(redRaw ?? '0'),
    };
  }

  // Modern browsers may serialize as `rgb(r g b / a)`.
  const slashMatch = value.match(
    /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/u
  );

  if (slashMatch === null) {
    throw new Error(`Could not parse color: ${value}`);
  }

  const [, redRaw, greenRaw, blueRaw, alphaRaw] = slashMatch;
  let alpha = 1;

  if (alphaRaw !== undefined) {
    alpha = alphaRaw.endsWith('%')
      ? Number.parseFloat(alphaRaw) / 100
      : Number.parseFloat(alphaRaw);
  }

  return {
    alpha,
    blue: Number.parseFloat(blueRaw ?? '0'),
    green: Number.parseFloat(greenRaw ?? '0'),
    red: Number.parseFloat(redRaw ?? '0'),
  };
};

const expectRgb = (
  value: string,
  expected: { blue: number; green: number; red: number },
  label: string
): void => {
  const parsed = parseRgba(value);
  expect(parsed.red, `${label} red from ${value}`).toBe(expected.red);
  expect(parsed.green, `${label} green from ${value}`).toBe(expected.green);
  expect(parsed.blue, `${label} blue from ${value}`).toBe(expected.blue);
};

/** Poll until track/knob colour settles past disabled/transition frames (exact channels). */
const expectRgbEventually = async (
  readColor: () => Promise<string>,
  expected: { blue: number; green: number; red: number },
  label: string
): Promise<string> => {
  await expect
    .poll(
      async () => {
        const value = await readColor();
        const parsed = parseRgba(value);
        return { alpha: parsed.alpha, blue: parsed.blue, green: parsed.green, red: parsed.red };
      },
      { timeout: 5000 }
    )
    .toEqual({ alpha: 1, blue: expected.blue, green: expected.green, red: expected.red });
  const settled = await readColor();
  expectRgb(settled, expected, label);
  return settled;
};

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

const readSwitchTrackBackground = (sidePanel: Page): Promise<string> =>
  analyticsSwitch(sidePanel).evaluate(element => getComputedStyle(element).backgroundColor);

const readSwitchKnobBackground = (sidePanel: Page): Promise<string> =>
  analyticsSwitch(sidePanel).evaluate(element => {
    const knob = element.querySelector('[aria-hidden="true"]');
    if (!(knob instanceof HTMLElement)) {
      throw new Error('Analytics switch knob was not found.');
    }
    return getComputedStyle(knob).backgroundColor;
  });

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

    // On state: brand accent track + dark knob (A3.1 / A3.2 / A3.4).
    // Poll past disabled/transition settle before reading exact channels.
    const onTrack = await expectRgbEventually(
      () => readSwitchTrackBackground(sidePanel),
      BRAND_PRIMARY_RGB,
      'analytics switch on track'
    );
    await expectRgbEventually(
      () => readSwitchKnobBackground(sidePanel),
      BRAND_PRIMARY_FOREGROUND_RGB,
      'analytics switch on knob'
    );

    await analyticsSwitch(sidePanel).click();
    const optOutBaseline = posthogRequests.length;

    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);
    expect(productEventsIn(posthogRequests.slice(optOutBaseline))).toHaveLength(0);

    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'false');
    const offTrack = await expectRgbEventually(
      () => readSwitchTrackBackground(sidePanel),
      SURFACE_OVERLAY_RGB,
      'analytics switch off track'
    );
    // Off knob stays muted; only assert it differs from the on-track accent.
    await expect
      .poll(
        async () => {
          const offKnobRgb = parseRgba(await readSwitchKnobBackground(sidePanel));
          return (
            offKnobRgb.red === BRAND_PRIMARY_RGB.red &&
            offKnobRgb.green === BRAND_PRIMARY_RGB.green &&
            offKnobRgb.blue === BRAND_PRIMARY_RGB.blue
          );
        },
        { timeout: 5000 }
      )
      .toBe(false);
    // Track colours must differ measurably between on and off (A3.2).
    const onTrackRgb = parseRgba(onTrack);
    const offTrackRgb = parseRgba(offTrack);
    expect(
      onTrackRgb.red !== offTrackRgb.red ||
        onTrackRgb.green !== offTrackRgb.green ||
        onTrackRgb.blue !== offTrackRgb.blue
    ).toBe(true);

    const afterReloadBaseline = posthogRequests.length;
    await sidePanel.reload();
    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await sidePanel.getByLabel('Settings').click();
    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'false');
    await expect
      .poll(() => readExtensionSyncStorage(sidePanel, ANALYTICS_OPT_OUT_KEY), { timeout: 5000 })
      .toBe(true);
    expect(productEventsIn(posthogRequests.slice(afterReloadBaseline))).toHaveLength(0);
    await expectRgbEventually(
      () => readSwitchTrackBackground(sidePanel),
      SURFACE_OVERLAY_RGB,
      'analytics switch off track after reload'
    );

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
    await expect(analyticsSwitch(sidePanel)).toHaveAttribute('aria-checked', 'true');
    await expectRgbEventually(
      () => readSwitchTrackBackground(sidePanel),
      BRAND_PRIMARY_RGB,
      'analytics switch on track after re-enable'
    );
    await expectRgbEventually(
      () => readSwitchKnobBackground(sidePanel),
      BRAND_PRIMARY_FOREGROUND_RGB,
      'analytics switch on knob after re-enable'
    );
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
      toolNames: [
        'get_page_snapshot',
        'get_element_details',
        'find_in_page',
        'search_memories',
        'get_memory',
      ],
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
