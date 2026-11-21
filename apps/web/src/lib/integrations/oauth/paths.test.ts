import { describe, expect, it } from '@jest/globals';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { STANDARD_OAUTH_PLATFORMS, getPlatformOAuthConnectPath } from './paths';

describe('STANDARD_OAUTH_PLATFORMS', () => {
  it('does not compose Bitbucket OAuth in V1', () => {
    expect(STANDARD_OAUTH_PLATFORMS).not.toContain(PLATFORM.BITBUCKET);
  });
});

describe('getPlatformOAuthConnectPath', () => {
  it('returns the bare connect path without options', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.SLACK)).toBe('/api/integrations/slack/connect');
  });

  it('returns the bare connect path for an empty options object', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.LINEAR, {})).toBe(
      '/api/integrations/linear/connect'
    );
  });

  it('appends organizationId when present', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.SLACK, { organizationId: 'org_123' })).toBe(
      '/api/integrations/slack/connect?organizationId=org_123'
    );
  });

  it('appends returnTo when present', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.SLACK, { returnTo: '/dashboard' })).toBe(
      '/api/integrations/slack/connect?returnTo=%2Fdashboard'
    );
  });

  it('appends both values in order when present', () => {
    expect(
      getPlatformOAuthConnectPath(PLATFORM.LINEAR, {
        organizationId: 'org_123',
        returnTo: '/settings',
      })
    ).toBe('/api/integrations/linear/connect?organizationId=org_123&returnTo=%2Fsettings');
  });

  it('omits empty strings from the query', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.SLACK, { organizationId: '', returnTo: '' })).toBe(
      '/api/integrations/slack/connect'
    );
  });

  it('omits an undefined value and keeps the defined one', () => {
    expect(
      getPlatformOAuthConnectPath(PLATFORM.DISCORD, { organizationId: undefined, returnTo: '/x' })
    ).toBe('/api/integrations/discord/connect?returnTo=%2Fx');
  });

  it('builds the Bitbucket connect path', () => {
    expect(getPlatformOAuthConnectPath(PLATFORM.BITBUCKET, { organizationId: 'org_123' })).toBe(
      '/api/integrations/bitbucket/connect?organizationId=org_123'
    );
  });
});
