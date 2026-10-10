import {
  expectElementToBeVisible,
  expectElementToHaveAttribute,
  expectElementToHaveCSS,
  expectElementToHaveCount,
  expectPageToContainURL,
  getLocator,
  getLocatorByRole,
  pressPageKeyboard,
} from '@anaconda/playwright-utils';
import { expect } from '@playwright/test';
import { appShellLayout, appShellMessages } from '@testdata/ui/app-shell/app-shell-test-data';

/** The app shell (sidebar, header, skip link) shared by every signed-in and `/admin` route. */
export class AppShellPage {
  private readonly main = () => getLocatorByRole('main');
  private readonly skipLink = () => getLocatorByRole('link', { name: appShellMessages.skipLink });
  private readonly mainContent = () => getLocator(`#${appShellLayout.mainContentId}`);
  private readonly sidebarToggle = () => getLocatorByRole('button', { name: appShellMessages.toggleSidebar });
  private readonly sidebarRail = () => getLocator('[data-sidebar="rail"]');
  private readonly sidebarMenuLink = (name: string) =>
    getLocator('[data-sidebar="menu"]').getByRole('link', { name, exact: true });
  // A desktop and a mobile header can both render; the first one is the topbar.
  private readonly header = () => getLocator('header').first();

  async pressTab(): Promise<void> {
    await pressPageKeyboard('Tab');
  }

  async pressEnter(): Promise<void> {
    await pressPageKeyboard('Enter');
  }

  async verifyOnPath(path: string): Promise<void> {
    await expectPageToContainURL(path, { message: `the page should be ${path}` });
  }

  async verifySingleMainLandmark(): Promise<void> {
    await expectElementToHaveCount(this.main(), 1, { message: 'there should be exactly one main landmark' });
    await expectElementToBeVisible(this.main(), { message: 'the main landmark should be visible' });
    await expectElementToHaveAttribute(this.main(), 'id', appShellLayout.mainContentId, {
      message: `the main landmark should carry the #${appShellLayout.mainContentId} id the skip link targets`,
    });
  }

  // playwright-utils has no focus assertion, so these use Playwright's `toBeFocused`.
  async verifySkipLinkFocused(): Promise<void> {
    await expect(this.skipLink(), 'the first Tab should focus the skip link').toBeFocused();
  }

  async verifyMainContentFocused(): Promise<void> {
    await expect(this.mainContent(), 'activating the skip link should focus the main content').toBeFocused();
  }

  /** The sidebar toggle is a full touch target; the collapsed rail is not a tab stop and stays narrow. */
  async verifySidebarTouchTargets(): Promise<void> {
    const minPx = appShellLayout.touchTargetMinPx;
    await expectElementToHaveCount(this.sidebarToggle(), 1, { message: 'there should be one sidebar toggle' });
    const toggleBox = await this.sidebarToggle().boundingBox();
    expect(toggleBox?.width, `the sidebar toggle should be at least ${minPx}px wide`).toBeGreaterThanOrEqual(minPx);
    expect(toggleBox?.height, `the sidebar toggle should be at least ${minPx}px tall`).toBeGreaterThanOrEqual(minPx);

    await expectElementToHaveAttribute(this.sidebarRail(), 'tabindex', '-1', {
      message: 'the collapsed sidebar rail should not be a tab stop',
    });
    const railBox = await this.sidebarRail().boundingBox();
    expect(railBox?.width, `the collapsed sidebar rail should be narrower than ${minPx}px`).toBeLessThan(minPx);
  }

  async verifyHeaderHeight(): Promise<void> {
    await expectElementToHaveCSS(this.header(), 'height', appShellLayout.headerHeight, {
      message: `the topbar should be ${appShellLayout.headerHeight} tall`,
    });
  }

  async verifyNavItemCurrent(name: string): Promise<void> {
    await expectElementToHaveAttribute(this.sidebarMenuLink(name), 'aria-current', 'page', {
      message: `the "${name}" sidebar item should be marked as the current page`,
    });
  }
}
