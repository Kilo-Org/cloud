import { STANDARD_TIMEOUT } from '@anaconda/playwright-utils';
import { type Page, expect } from '@playwright/test';

/**
 * React adds `__reactProps$…` keys to a DOM node once it has hydrated it. The app shell's
 * `#main-content` (or `body` on pages without it) having them, with `readyState === 'complete'`,
 * means the page is interactive.
 */
async function isHydrated(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const target = document.querySelector('#main-content') ?? document.body;
    const hasReactProps = target !== null && Object.keys(target).some(key => key.startsWith('__reactProps$'));
    return hasReactProps && document.readyState === 'complete';
  });
}

/**
 * Waits up to `STANDARD_TIMEOUT` for hydration and never throws: a page that never hydrates (e.g. an
 * external redirect) must not fail a navigation that succeeded; the test's own checks will fail.
 */
async function waitForHydration(page: Page): Promise<void> {
  try {
    await expect.poll(() => isHydrated(page), { timeout: STANDARD_TIMEOUT }).toBe(true);
  } catch {
    // See above.
  }
}

/**
 * `next dev` adds a `<nextjs-portal>` dev-tools overlay that can intercept clicks on the sidebar's
 * bottom-left controls. It doesn't exist in production builds, so it is made click-through.
 */
async function neutralizeNextDevOverlay(page: Page): Promise<void> {
  try {
    await page.addStyleTag({ content: 'nextjs-portal { pointer-events: none !important; }' });
  } catch {
    // The page navigated away before the style could attach.
  }
}

/**
 * Makes every `goto`/`reload` on `page` wait for React hydration, because a click or keystroke
 * before hydration is silently lost. Patching the page instance means the library's `gotoURL` and
 * `reloadPage`, which call `page.goto`/`page.reload`, get the wait too.
 */
export function installHydrationWait(page: Page): void {
  const originalGoto = page.goto.bind(page);
  page.goto = async (...args: Parameters<Page['goto']>) => {
    const response = await originalGoto(...args);
    await neutralizeNextDevOverlay(page);
    await waitForHydration(page);
    return response;
  };

  const originalReload = page.reload.bind(page);
  page.reload = async (...args: Parameters<Page['reload']>) => {
    const response = await originalReload(...args);
    await neutralizeNextDevOverlay(page);
    await waitForHydration(page);
    return response;
  };
}
