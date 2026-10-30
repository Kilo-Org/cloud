import { getRequest } from '@anaconda/playwright-utils';
import { type APIResponse, expect } from '@playwright/test';
import { getStartedPaths } from '@testdata/ui/auth/get-started-test-data';
import { redirectStatuses } from '@testdata/api/auth/get-started-api-test-data';

/** `/get-started` over HTTP, without following redirects. */
export class GetStartedApi {
  requestGetStarted(): Promise<APIResponse> {
    return getRequest(getStartedPaths.getStarted, { maxRedirects: 0 });
  }

  verifyRedirectsToInstall(response: APIResponse): void {
    expect(redirectStatuses, 'a signed-out visitor should get a redirect').toContain(response.status());
    const location = response.headers()['location'];
    expect(location, 'the redirect should have a Location header').toBeTruthy();
    expect(new URL(location ?? '', response.url()).pathname, 'the redirect should go to the install page').toBe(
      getStartedPaths.install,
    );
  }
}
