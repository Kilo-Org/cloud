import { expectPageToHaveURL, gotoURL } from '@anaconda/playwright-utils';
import { getStartedPaths, signedInDestinationRegExp } from '@testdata/ui/auth/get-started-test-data';

/** `/get-started`: the auth-aware router that sends a signed-in visitor straight into the app. */
export class GetStartedPage {
  async navigateToGetStarted(): Promise<void> {
    await gotoURL(getStartedPaths.getStarted);
  }

  async verifyOnSignedInDestination(): Promise<void> {
    await expectPageToHaveURL(signedInDestinationRegExp, {
      message: 'a signed-in visitor should be on their profile or an organization page',
    });
  }
}
