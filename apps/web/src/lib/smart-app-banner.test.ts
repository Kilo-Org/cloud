import { APP_URL } from '@/lib/constants';
import { UNIVERSAL_LINK_ROUTES } from '@kilocode/app-shared/universal-links';
import { smartAppBannerItunes } from '@/lib/smart-app-banner';

describe('smartAppBannerItunes', () => {
  it('returns appId only when called with no path', () => {
    const result = smartAppBannerItunes();
    expect(result).toEqual({ appId: '6761193135' });
    expect(result).not.toHaveProperty('appArgument');
  });

  it.each(['/profile', '/code-reviews', '/security-agent/findings', '/cloud/sessions'] as const)(
    'sets appArgument for surface path %s',
    path => {
      expect(smartAppBannerItunes(path)).toEqual({
        appId: '6761193135',
        appArgument: `${APP_URL}${path}`,
      });
    }
  );

  it('accepts every literal UNIVERSAL_LINK_ROUTES webPath', () => {
    const literalPaths = UNIVERSAL_LINK_ROUTES.map(route => route.webPath).filter(
      webPath => !webPath.includes('*')
    );

    for (const path of literalPaths) {
      expect(smartAppBannerItunes(path)).toEqual({
        appId: '6761193135',
        appArgument: `${APP_URL}${path}`,
      });
    }
  });

  it.each(['/admin', '/s/sess_1', '/code-reviews/review-md', '/login'] as const)(
    'throws for unmapped path %s',
    path => {
      expect(() => smartAppBannerItunes(path)).toThrow(
        `smartAppBannerItunes: path "${path}" is not deep-linkable`
      );
    }
  );
});
