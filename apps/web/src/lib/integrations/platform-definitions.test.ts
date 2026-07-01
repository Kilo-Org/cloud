import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  buildPlatforms,
  getPlatformDefinitionCountForOwner,
} from '@/lib/integrations/platform-definitions';

describe('integration platform definitions', () => {
  it('omits Bitbucket from personal integrations', () => {
    const platforms = buildPlatforms([]);

    expect(platforms.map(platform => platform.id)).not.toContain(PLATFORM.BITBUCKET);
  });

  it('includes Bitbucket for organization integrations and owner-scoped skeletons', () => {
    const organizationId = '123e4567-e89b-12d3-a456-426614174000';
    const platforms = buildPlatforms([], organizationId);

    expect(platforms.map(platform => platform.id)).toContain(PLATFORM.BITBUCKET);
    expect(getPlatformDefinitionCountForOwner(organizationId)).toBe(
      getPlatformDefinitionCountForOwner() + 1
    );
  });
});
