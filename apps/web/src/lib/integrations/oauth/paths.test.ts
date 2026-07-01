import { describe, expect, it } from '@jest/globals';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { STANDARD_OAUTH_PLATFORMS } from './paths';

describe('STANDARD_OAUTH_PLATFORMS', () => {
  it('does not compose Bitbucket OAuth in V1', () => {
    expect(STANDARD_OAUTH_PLATFORMS).not.toContain(PLATFORM.BITBUCKET);
  });
});
