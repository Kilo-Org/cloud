import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function createOrgRig(orgName: string, integrationId: string) {
  const org = env.GASTOWN_ORG.get(env.GASTOWN_ORG.idFromName(orgName));
  const town = await org.createTown({
    name: `${orgName} town`,
    owner_org_id: orgName,
    created_by_user_id: `${orgName} owner`,
  });
  return org.createRig({
    town_id: town.id,
    name: `${orgName} rig`,
    git_url: `https://github.com/${orgName}/repo.git`,
    default_branch: 'main',
    platform_integration_id: integrationId,
  });
}

describe('Gastown rig owner identity', () => {
  it('isolates platform integrations for rigs owned by different organizations', async () => {
    const first = await createOrgRig('org-one', 'integration-one');
    const second = await createOrgRig('org-two', 'integration-two');

    const firstOrg = env.GASTOWN_ORG.get(env.GASTOWN_ORG.idFromName('org-one'));
    const secondOrg = env.GASTOWN_ORG.get(env.GASTOWN_ORG.idFromName('org-two'));

    expect(await firstOrg.getRigAsync(first.id)).toMatchObject({
      platform_integration_id: 'integration-one',
    });
    expect(await secondOrg.getRigAsync(second.id)).toMatchObject({
      platform_integration_id: 'integration-two',
    });
    expect(await firstOrg.getRigAsync(second.id)).toBeNull();
    expect(await secondOrg.getRigAsync(first.id)).toBeNull();
  });
});
