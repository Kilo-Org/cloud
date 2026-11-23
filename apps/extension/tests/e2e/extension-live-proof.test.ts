import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { startDownloadFixture, USER_PAGE_PATH } from './download-fixture';
import { seedExtensionAuth } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { activateTab } from './local-agents-fixture';
import { launchRealDownloadBrowser } from './real-download-launch';

/*
 * The unpacked build as Chrome itself lists it: the manager page with developer
 * mode on, and the extension's own name in the item list. The manager is a
 * nested shadow-DOM tree, so both the toggle and the name are read through the
 * same roots the click used rather than through `getByRole`, which does not see
 * into a closed-over shadow surface from outside.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object destructured, and this spec takes no fixture: every page is opened on the launch's own context.
test('the unpacked build is listed with developer mode on', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const launch = await launchRealDownloadBrowser();

  try {
    const page = await launch.context.newPage();

    await page.goto('chrome://extensions');

    // The manager is a nested shadow-DOM tree: chrome://extensions > extensions-manager
    // > shadowRoot > extensions-toolbar > shadowRoot > #devMode (a cr-toggle).
    //
    // The manager builds its toolbar and item list from `chrome.developerPrivate` after the load event that
    // `goto` waits on, so both are read in one poll: a single read can catch an empty shadow tree and fail
    // On scheduling instead of on the build.
    const managerStateSchema = z.object({
      itemId: z.string().nullable(),
      name: z.string(),
      toggled: z.string().nullable(),
    });

    const readManager = async () => {
      await page.evaluate(`(() => {
        const toolbar = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar');
        const toggle = toolbar?.shadowRoot?.querySelector('#devMode');
        if (toggle && toggle.getAttribute('aria-checked') !== 'true') { toggle.click(); }
      })()`);

      return managerStateSchema.parse(
        await page.evaluate(`(() => {
          const manager = document.querySelector('extensions-manager');
          const toolbar = manager?.shadowRoot?.querySelector('extensions-toolbar');
          const toggle = toolbar?.shadowRoot?.querySelector('#devMode');
          const list = manager?.shadowRoot?.querySelector('extensions-item-list');
          const item = list?.shadowRoot?.querySelector('extensions-item');
          const name = item?.shadowRoot?.querySelector('#name');
          return {
            itemId: item?.getAttribute('id') ?? null,
            name: (name?.textContent ?? '').trim(),
            toggled: toggle?.getAttribute('aria-checked') ?? null
          };
        })()`)
      );
    };

    // Polls until the manager has rendered both, so a slow manager fails on its own state rather than on scheduling.
    await expect
      .poll(
        async () => {
          const state = await readManager();

          return { name: state.name, toggled: state.toggled };
        },
        { timeout: 30_000 }
      )
      .toEqual({ name: 'Kilo Code', toggled: 'true' });

    const managerState = await readManager();

    expect(managerState.toggled).toBe('true');
    expect(managerState.name).toBe('Kilo Code');

    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('00-extension-manager.png'),
    });
  } finally {
    await launch.close();
  }
});

/*
 * The panel's own error surface, captured from the unpacked build in a real
 * browser: a live turn whose gateway answers an error, rendered by the panel's
 * error handling on a real fixture page.
 *
 * The guarded browser calls are covered by the agent-path specs in
 * `local-agents-download.test.ts`, which drive the same loaded build.
 *
 * Nothing here is a stub of the extension: Chrome is started as a child process
 * with the built unpacked extension, Playwright attaches over CDP, and the only
 * faked pieces are the Kilo API routes.
 */

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures object destructured, and this spec takes no fixture: every page is opened on the launch's own context.
test('the panel shows its own gateway error in the real browser', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await startDownloadFixture();
  const launch = await launchRealDownloadBrowser();
  const { context, extensionId } = launch;
  await mockKiloApi(context, {});

  /*
   * Registered after `mockKiloApi`, so this handler runs first: Playwright tries
   * the most recently added route for a matching request. The gateway answers a
   * 500, which the turn runner retries transparently twice before the panel
   * reports it, so the alert appears only after the retry delays.
   */
  await context.route('https://app.kilo.ai/api/gateway/v1/chat/completions', route =>
    route.fulfill({ json: { error: { message: 'stub failure' } }, status: 500 })
  );

  try {
    const targetPage = await context.newPage();
    await targetPage.goto(`${fixture.url}${USER_PAGE_PATH}`);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    // A tab opened over CDP is a background tab, so a click there would wait on an animation frame that never runs.
    await sidePanel.bringToFront();

    const composer = sidePanel.getByLabel('Message agent');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // The panel adopts the active tab after signing in, so bring the fixture page forward and let it pick it up.
    await activateTab(sidePanel, `${fixture.url}${USER_PAGE_PATH}`);
    await sidePanel.bringToFront();

    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill('What does this page say?');
    await composer.press('Enter');

    const alert = sidePanel
      .getByRole('alert')
      .filter({ hasText: 'The server is busy. Try again in a moment.' });

    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert.getByRole('button', { exact: true, name: 'Retry' })).toBeVisible();
    await alert.scrollIntoViewIfNeeded();
    await sidePanel.screenshot({
      fullPage: true,
      path: testInfo.outputPath('side-panel-gateway-error.png'),
    });
  } finally {
    await launch.close();
    await fixture.close();
  }
});
