/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { dangerousToolNames, mockKiloApi, readSidePanelScrollState } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

const longCodeBlock = (prefix: string, lineCount: number, language: string): string => {
  const lines = Array.from({ length: lineCount }, (_value, index) => `${prefix} ${index + 1}`);

  return `\`\`\`${language}\n${lines.join('\n')}\n\`\`\``;
};

const collapsibleCodeMarkdown = [
  longCodeBlock('line', 20, 'ts'),
  '',
  longCodeBlock('other', 18, 'ts'),
  '',
  longCodeBlock('short', 3, 'ts'),
].join('\n');

const readHorizontalOverflowState = (): {
  conversationHasHorizontalScroll: boolean;
  documentFitsWidth: boolean;
} => {
  const conversation = document.querySelector('[aria-label="Agent conversation"]');

  if (!(conversation instanceof HTMLElement)) {
    throw new Error('Agent conversation pane was not found.');
  }

  return {
    conversationHasHorizontalScroll: conversation.scrollWidth > conversation.clientWidth,
    documentFitsWidth: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  };
};

test('long assistant code blocks are collapsible', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: collapsibleCodeMarkdown,
              },
            },
          ],
        },
      ],
      toolNames: dangerousToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Show collapsible code');
    await sidePanel.getByLabel('Message agent').press('Enter');

    const showMore20 = sidePanel.getByRole('button', { name: 'Show more (20 lines)' });
    const showMore18 = sidePanel.getByRole('button', { name: 'Show more (18 lines)' });

    await expect(showMore20).toBeVisible();
    await expect(showMore18).toBeVisible();
    await expect(showMore20).toHaveAttribute('aria-expanded', 'false');
    await expect(showMore18).toHaveAttribute('aria-expanded', 'false');
    await expect(sidePanel.getByRole('button', { name: /^Show more|^Show less/u })).toHaveCount(2);

    const firstBlock = sidePanel
      .locator('div.relative.min-w-0')
      .filter({ has: showMore20 })
      .first();
    const secondBlock = sidePanel
      .locator('div.relative.min-w-0')
      .filter({ has: showMore18 })
      .first();

    await expect(firstBlock.locator('pre code')).toContainText('line 1');
    await expect(firstBlock.locator('pre code')).toContainText('line 8');
    await expect(firstBlock.locator('pre code')).not.toContainText('line 9');
    await expect(sidePanel.locator('body')).not.toContainText('line 9');
    await expect(firstBlock.locator('div[aria-hidden="true"]')).toBeVisible();

    await expect(secondBlock.locator('pre code')).toContainText('other 1');
    await expect(secondBlock.locator('pre code')).toContainText('other 8');
    await expect(secondBlock.locator('pre code')).not.toContainText('other 9');
    await expect(sidePanel.locator('body')).not.toContainText('other 9');

    await expect(sidePanel.locator('pre code').filter({ hasText: 'short 1' })).toContainText(
      'short 3'
    );
    await expect(sidePanel.locator('body')).toContainText('short 1');
    await expect(sidePanel.locator('body')).toContainText('short 2');
    await expect(sidePanel.locator('body')).toContainText('short 3');
    await expect(sidePanel.getByRole('button', { name: 'Show more (3 lines)' })).toHaveCount(0);

    const noHorizontalOverflow = await sidePanel.evaluate(readHorizontalOverflowState);

    expect(noHorizontalOverflow.documentFitsWidth).toBe(true);
    expect(noHorizontalOverflow.conversationHasHorizontalScroll).toBe(false);

    await showMore20.click();

    const showLess = sidePanel.getByRole('button', { name: 'Show less' });

    await expect(showLess).toBeVisible();
    await expect(showLess).toHaveAttribute('aria-expanded', 'true');
    await expect(sidePanel.getByRole('button', { name: 'Show more (20 lines)' })).toHaveCount(0);
    await expect(sidePanel.locator('body')).toContainText('line 20');
    await expect(sidePanel.locator('body')).not.toContainText('other 18');
    await expect(showMore18).toBeVisible();
    await expect(showMore18).toHaveAttribute('aria-expanded', 'false');
    await expect(showMore18).toHaveText(/Show more \(18 lines\)/u);

    await showLess.click();

    await expect(showMore20).toBeVisible();
    await expect(showMore20).toHaveAttribute('aria-expanded', 'false');
    await expect(sidePanel.getByRole('button', { name: 'Show less' })).toHaveCount(0);
    await expect(sidePanel.locator('body')).not.toContainText('line 20');
    await expect(showMore18).toHaveAttribute('aria-expanded', 'false');

    await expect(sidePanel.getByLabel('Agent conversation')).toBeVisible();

    const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(scrollState.documentScrollHeight).toBe(scrollState.documentClientHeight);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
