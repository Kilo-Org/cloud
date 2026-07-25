/* eslint-disable id-length, import/no-nodejs-modules, jest/no-conditional-in-test, jest/valid-expect, max-lines, max-params, no-continue */
/**
 * Computed-style E2E for kilo-design token alignment (plan §4.8 Cases A–E).
 * Pins token RGBs and font families only — no layout geometry.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

const safeToolNames = [
  'get_page_snapshot',
  'get_element_details',
  'find_in_page',
  'search_memories',
  'get_memory',
] as const;

const modelWithContextLength = [
  {
    contextLength: 1000,
    id: 'anthropic/claude-sonnet-4',
    name: 'Anthropic: Claude Sonnet 4',
    variants: { high: {}, low: {}, medium: {} },
  },
];

const UNIQUE_USER_TEXT = 'Design-token user bubble 7f3a9c';
const THINKING_BODY = 'Reasoning about the page snapshot…';
const CONVERSATION_ID = 'design-tokens-conv-1';
const CONVERSATION_TITLE = 'Design token seed conversation';

/** Schema-valid conversation seed for Cases C and E (inline — no @/ imports). */
const designTokenConversationStore = {
  activeConversationId: CONVERSATION_ID,
  conversations: [
    {
      events: [
        {
          id: 'evt-user-1',
          role: 'user',
          text: UNIQUE_USER_TEXT,
          type: 'message',
        },
        {
          id: 'evt-assistant-1',
          role: 'assistant',
          text: 'Here is a sample:\n\n```ts\nconst answer = 42;\n```\n\nDone.',
          type: 'message',
        },
        {
          id: 'evt-thinking-1',
          text: THINKING_BODY,
          type: 'thinking',
        },
        {
          id: 'evt-tool-ok-call',
          name: 'get_page_snapshot',
          tabId: 1,
          type: 'tool-call',
        },
        {
          id: 'evt-tool-ok-result',
          ok: true,
          toolCallId: 'evt-tool-ok-call',
          type: 'tool-result',
          value: '{"title":"Fixture page"}',
        },
        {
          id: 'evt-tool-fail-call',
          name: 'get_page_snapshot',
          tabId: 1,
          type: 'tool-call',
        },
        {
          error: 'snapshot timed out',
          id: 'evt-tool-fail-result',
          ok: false,
          toolCallId: 'evt-tool-fail-call',
          type: 'tool-result',
        },
        {
          error: 'orphan tool failed',
          id: 'evt-standalone-fail',
          ok: false,
          toolCallId: 'no-such-call',
          type: 'tool-result',
        },
      ],
      id: CONVERSATION_ID,
      title: CONVERSATION_TITLE,
      updatedAt: '2026-07-25T10:00:00.000Z',
    },
  ],
  openConversationIds: [CONVERSATION_ID],
};

interface ComputedStyles {
  backgroundColor: string;
  borderTopColor: string;
  borderTopWidth: string;
  color: string;
  fontFamily: string;
  fontSize: string;
  textTransform: string;
}

const readComputed = (locator: Locator): Promise<ComputedStyles> =>
  locator.evaluate(element => {
    const style = getComputedStyle(element);

    return {
      backgroundColor: style.backgroundColor,
      borderTopColor: style.borderTopColor,
      borderTopWidth: style.borderTopWidth,
      color: style.color,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      textTransform: style.textTransform,
    };
  });

interface RgbaChannels {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

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

const expectBorderTop = (
  styles: Pick<ComputedStyles, 'borderTopColor' | 'borderTopWidth'>,
  channels: RgbaChannels,
  label: string
): void => {
  expect(styles.borderTopWidth, `${label} border-top-width`).toBe('1px');
  const parsed = parseRgba(styles.borderTopColor);
  expect(parsed.red, `${label} border red`).toBe(channels.red);
  expect(parsed.green, `${label} border green`).toBe(channels.green);
  expect(parsed.blue, `${label} border blue`).toBe(channels.blue);
  expect(
    Math.abs(parsed.alpha - channels.alpha),
    `${label} border alpha from ${styles.borderTopColor}`
  ).toBeLessThanOrEqual(0.01);
};

const borderDefault: RgbaChannels = { alpha: 0.102, blue: 255, green: 255, red: 255 };
const borderError: RgbaChannels = { alpha: 1, blue: 68, green: 68, red: 239 };

const openSignedInPanel = async (
  context: Awaited<ReturnType<typeof launchExtensionContext>>['context'],
  extensionId: string,
  fixtureUrl: string
): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await seedExtensionAuth(sidePanel);
  await sidePanel.reload();

  return sidePanel;
};

const conversationPane = (sidePanel: Page): Locator => sidePanel.getByLabel('Agent conversation');

const seedConversationAndReload = async (sidePanel: Page): Promise<void> => {
  await setExtensionStorage(sidePanel, { kiloAgentConversations: designTokenConversationStore });
  await sidePanel.reload();
  // Scope to the transcript pane — the tab label also mirrors the first user message.
  await expect(conversationPane(sidePanel).getByText(UNIQUE_USER_TEXT)).toBeVisible();
};

/** Wait until computed background settles (class transitions can leave mid-blend RGB). */
const expectBackgroundRgb = async (
  locator: Locator,
  expected: { blue: number; green: number; red: number },
  label: string
): Promise<ComputedStyles> => {
  await expect
    .poll(
      async () => {
        const styles = await readComputed(locator);
        const parsed = parseRgba(styles.backgroundColor);

        return `${parsed.red},${parsed.green},${parsed.blue}`;
      },
      { timeout: 5000 }
    )
    .toBe(`${expected.red},${expected.green},${expected.blue}`);

  const styles = await readComputed(locator);
  expectRgb(styles.backgroundColor, expected, label);

  return styles;
};

test('Case A — shell tokens', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: [...safeToolNames] });
    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);

    await expect(sidePanel.getByLabel('Message agent')).toBeVisible();

    const bodyStyles = await sidePanel.locator('body').evaluate(element => {
      const style = getComputedStyle(element);

      return {
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
      };
    });

    expectRgb(bodyStyles.backgroundColor, { blue: 21, green: 21, red: 21 }, 'body background');
    expect(bodyStyles.fontFamily, `body font-family ${bodyStyles.fontFamily}`).toMatch(/Inter/u);

    const footer = sidePanel.locator('footer');
    await expect(footer).toBeVisible();
    const footerStyles = await readComputed(footer);
    expectRgb(footerStyles.backgroundColor, { blue: 32, green: 32, red: 32 }, 'footer background');
    expectBorderTop(footerStyles, borderDefault, 'footer');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case B — enabled Send brand', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: [...safeToolNames] });
    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);

    await sidePanel.getByLabel('Message agent').fill('Draft for brand assert');
    const sendButton = sidePanel.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeEnabled();
    // Move pointer off the control so hover: styles cannot override brand fill.
    await sidePanel.mouse.move(0, 0);
    await expect(sendButton).toHaveClass(/bg-brand-primary/u);

    const styles = await expectBackgroundRgb(
      sendButton,
      { blue: 134, green: 245, red: 247 },
      'enabled Send background'
    );
    expectRgb(styles.color, { blue: 31, green: 31, red: 31 }, 'enabled Send color');
    expect(styles.borderTopWidth, 'enabled Send border-top-width').toBe('1px');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case B — disabled Send', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: [...safeToolNames] });
    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);

    const sendButton = sidePanel.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeDisabled();
    await sidePanel.mouse.move(0, 0);

    const styles = await expectBackgroundRgb(
      sendButton,
      { blue: 69, green: 69, red: 69 },
      'disabled Send background'
    );
    expectRgb(styles.color, { blue: 122, green: 122, red: 122 }, 'disabled Send color');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case B — Stop secondary', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Should not finish yet.' } }] }],
      toolNames: [...safeToolNames],
    });

    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);

    await sidePanel.getByLabel('Message agent').fill('Hold the turn open');
    const sendButton = sidePanel.getByRole('button', { name: 'Send message' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible();
    // Clear hover from the submit click so hover:bg-surface-hover cannot win.
    await sidePanel.mouse.move(0, 0);
    await expect(stopButton).toHaveClass(/bg-surface-overlay/u);

    const styles = await expectBackgroundRgb(
      stopButton,
      { blue: 51, green: 51, red: 51 },
      'Stop background'
    );
    expectBorderTop(styles, borderDefault, 'Stop');
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case C — transcript recipes', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: [...safeToolNames] });
    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);
    await seedConversationAndReload(sidePanel);
    const pane = conversationPane(sidePanel);

    // User bubble
    const userText = pane.getByText(UNIQUE_USER_TEXT);
    await expect(userText).toBeVisible();
    const userBubble = userText.locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
    const userStyles = await expectBackgroundRgb(
      userBubble,
      { blue: 32, green: 32, red: 32 },
      'user bubble background'
    );
    expectRgb(userStyles.color, { blue: 250, green: 250, red: 250 }, 'user bubble color');
    expectBorderTop(userStyles, borderDefault, 'user bubble');

    // Markdown mono (fenced block)
    const fenceCode = pane.locator('.agent-message-markdown pre code').first();
    await expect(fenceCode).toBeVisible();
    const monoStyles = await readComputed(fenceCode);
    expect(monoStyles.fontFamily, `mono font ${monoStyles.fontFamily}`).toMatch(/Roboto Mono/u);
    expect(monoStyles.fontSize, 'mono font-size').toBe('14px');

    // Error panel shell
    const errorSummary = pane.getByText('get_page_snapshot failed', { exact: true });
    await expect(errorSummary).toBeVisible();
    const errorPanel = errorSummary.locator('xpath=ancestor::details[1]');
    const errorStyles = await expectBackgroundRgb(
      errorPanel,
      { blue: 11, green: 18, red: 66 },
      'error panel background'
    );
    expectBorderTop(errorStyles, borderError, 'error panel');

    // Nested Error label (expand first)
    await errorSummary.click();
    const errorLabel = errorPanel.getByText('Error', { exact: true });
    await expect(errorLabel).toBeVisible();
    const errorLabelStyles = await readComputed(errorLabel);
    expectRgb(errorLabelStyles.color, { blue: 165, green: 165, red: 252 }, 'Error label color');

    // Success well
    const successSummary = pane.getByText('get_page_snapshot completed', { exact: true });
    await expect(successSummary).toBeVisible();
    const successPanel = successSummary.locator('xpath=ancestor::details[1]');
    const successStyles = await expectBackgroundRgb(
      successPanel,
      { blue: 16, green: 16, red: 16 },
      'success well background'
    );
    expectBorderTop(successStyles, borderDefault, 'success well');
    const successTitleStyles = await readComputed(successSummary);
    expectRgb(
      successTitleStyles.color,
      { blue: 250, green: 250, red: 250 },
      'success summary color'
    );

    // Thinking
    const thinkingLabel = pane.getByText('thinking', { exact: true });
    await expect(thinkingLabel).toBeVisible();
    const thinkingPanel = thinkingLabel.locator('xpath=ancestor::details[1]');
    const thinkingStyles = await expectBackgroundRgb(
      thinkingPanel,
      { blue: 16, green: 16, red: 16 },
      'thinking background'
    );
    expectBorderTop(thinkingStyles, borderDefault, 'thinking');
    const thinkingLabelStyles = await readComputed(thinkingLabel);
    expectRgb(
      thinkingLabelStyles.color,
      { blue: 163, green: 163, red: 163 },
      'thinking summary color'
    );

    // Standalone error event
    const standaloneTitle = pane.getByText('tool error', { exact: true });
    await expect(standaloneTitle).toBeVisible();
    const standaloneRoot = standaloneTitle.locator(
      'xpath=ancestor::div[contains(@class,"rounded")][1]'
    );
    const standaloneStyles = await expectBackgroundRgb(
      standaloneRoot,
      { blue: 11, green: 18, red: 66 },
      'standalone error background'
    );
    expectBorderTop(standaloneStyles, borderError, 'standalone error');

    // Agent message container (unpainted canvas)
    const agentPre = pane.locator('.agent-message-markdown pre').first();
    await expect(agentPre).toBeVisible();
    const agentContainer = agentPre.locator('xpath=ancestor::div[contains(@class,"rounded")][1]');
    const agentStyles = await readComputed(agentContainer);
    expect(agentStyles.backgroundColor, 'agent container fill').toMatch(
      /^(?:rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|rgba?\(\s*0\s+0\s+0\s*\/\s*0\s*\)|transparent)$/u
    );
    expect(agentStyles.borderTopWidth, 'agent container border-top-width').toBe('0px');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case D — donut status stroke', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Donut reply.' } }] },
        { choices: [], usage: { completion_tokens: 10, prompt_tokens: 850, total_tokens: 860 } },
      ],
      models: modelWithContextLength,
      toolNames: [...safeToolNames],
    });

    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);

    await sidePanel.getByLabel('Message agent').fill('Show me usage');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Donut reply.')).toBeVisible();

    const donut = sidePanel.getByLabel(/^Context usage:/u);
    await expect(donut).toBeVisible();
    // Readiness gate: warn tone only after 85% is reflected in the label.
    await expect(donut).toHaveAttribute('aria-label', /85%/u);

    const stroke = await donut.locator('circle[stroke-dasharray]').getAttribute('stroke');
    expect(stroke?.toLowerCase(), `donut stroke ${stroke}`).toBe('#f0a900');
    expect(stroke?.toLowerCase()).not.toBe('#edff00');

    // Track circle (no dasharray) must step down from the overlay button fill.
    const trackStroke = await donut
      .locator('circle:not([stroke-dasharray])')
      .getAttribute('stroke');
    expect(trackStroke?.toLowerCase(), `donut track stroke ${trackStroke}`).toBe('#151515');
    const donutBg = await donut.evaluate(element => getComputedStyle(element).backgroundColor);
    expectRgb(donutBg, { blue: 51, green: 51, red: 51 }, 'donut summary button background');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Case E — eyebrow + old-paint scan', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: [...safeToolNames] });
    const sidePanel = await openSignedInPanel(context, extensionId, fixture.url);
    await seedConversationAndReload(sidePanel);

    await sidePanel.getByLabel('History').click();
    // History rows use getStoredConversationTitle (first user message), not store.title.
    await expect(sidePanel.getByText(UNIQUE_USER_TEXT).first()).toBeVisible();

    const openChip = sidePanel.locator('span.type-eyebrow', { hasText: /^Open$/u });
    await expect(openChip).toBeVisible();
    const chipStyles = await readComputed(openChip);
    expect(chipStyles.fontSize, 'Open chip font-size').toBe('11px');
    expect(chipStyles.textTransform, 'Open chip text-transform').toBe('uppercase');

    // Bounded old-paint scan: no legacy brand yellow or zinc-950 body paint.
    // Compare parsed RGB channels (alpha-agnostic) so serialization form does not matter.
    const colorSamples = await sidePanel.locator('body *').evaluateAll(elements =>
      elements.flatMap(element => {
        if (!(element instanceof HTMLElement)) {
          return [];
        }

        const { backgroundColor, color } = getComputedStyle(element);

        return [
          {
            backgroundColor,
            className: String(element.className),
            color,
            tag: element.tagName.toLowerCase(),
          },
        ];
      })
    );

    const bannedChannels = [
      { blue: 0, green: 255, red: 237 },
      { blue: 11, green: 9, red: 9 },
    ] as const;

    const offenders = colorSamples.flatMap(sample => {
      const matchesBanned = (value: string): boolean => {
        try {
          const parsed = parseRgba(value);

          return bannedChannels.some(
            banned =>
              parsed.red === banned.red &&
              parsed.green === banned.green &&
              parsed.blue === banned.blue
          );
        } catch {
          return false;
        }
      };

      if (!matchesBanned(sample.color) && !matchesBanned(sample.backgroundColor)) {
        return [];
      }

      return [
        `${sample.tag}.${sample.className}: color=${sample.color} bg=${sample.backgroundColor}`,
      ];
    });

    expect(offenders, offenders.join('\n')).toStrictEqual([]);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
