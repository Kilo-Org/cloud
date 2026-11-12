import { afterEach, describe, expect, it } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { cloudEnvironmentsRouter } from './cloud-environments-router';

const createCaller = createCallerFactory(
  createTRPCRouter({ cloudEnvironments: cloudEnvironmentsRouter })
);
const USER_ID = 'oauth/github|scoped-environment-owner';
const PARENT_SESSION_ID = 'workspace_9a345678-1234-4234-9234-123456789abc';
const REPOSITORY = { platform: 'github' as const, fullName: 'acme/widgets' };

function authorityFor(organizationId: string | null): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: USER_ID,
    parentSessionId: PARENT_SESSION_ID,
    organizationId,
    authorizationId: '6a345678-1234-4234-9234-123456789abc',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function callerFor(user: User, cloudAgentAuthority?: CloudAgentAuthority) {
  return createCaller({
    user,
    cloudAgentAuthority,
    headersList: new Headers({ authorization: 'Bearer scoped-token' }),
  } as TRPCContext);
}

afterEach(cleanupDbForTest);

describe('scoped cloud environment listing', () => {
  it('lists the signed organization and returns secret-free summaries', async () => {
    const user = await insertTestUser({ id: USER_ID });
    const organization = await createTestOrganization('Scoped environment org', user.id, 0);
    const { id } = await callerFor(user).cloudEnvironments.create({
      organizationId: organization.id,
      name: 'shared',
      repository: REPOSITORY,
      plainVars: { PUBLIC_VALUE: 'visible-value' },
      secrets: { SECRET_TOKEN: 'must-not-leak' },
      commands: ['pnpm install'],
    });

    const summaries = await callerFor(user, authorityFor(organization.id)).cloudEnvironments.list({
      organizationId: organization.id,
      repository: REPOSITORY,
    });

    expect(summaries.map(summary => summary.id)).toEqual([id]);
    expect(summaries[0]).toMatchObject({
      name: 'shared',
      repoFullName: REPOSITORY.fullName,
      plainVarCount: 1,
      secretCount: 1,
      commandCount: 1,
    });
    expect(summaries[0]).not.toHaveProperty('secrets');
    expect(summaries[0]).not.toHaveProperty('plainVars');
    expect(summaries[0]).not.toHaveProperty('secretKeys');
    expect(JSON.stringify(summaries)).not.toContain('must-not-leak');
    expect(JSON.stringify(summaries)).not.toContain('SECRET_TOKEN');
  });

  it('denies another organization even when the owner belongs to both', async () => {
    const user = await insertTestUser({ id: USER_ID });
    const organization = await createTestOrganization('Scoped environment A', user.id, 0);
    const otherOrganization = await createTestOrganization('Scoped environment B', user.id, 0);

    await expect(
      callerFor(user, authorityFor(organization.id)).cloudEnvironments.list({
        organizationId: otherOrganization.id,
        repository: REPOSITORY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      callerFor(user, authorityFor(organization.id)).cloudEnvironments.list({
        repository: REPOSITORY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('denies personal authority injecting an organization scope', async () => {
    const user = await insertTestUser({ id: USER_ID });
    const organization = await createTestOrganization('Scoped environment C', user.id, 0);
    await callerFor(user).cloudEnvironments.create({
      name: 'personal',
      repository: REPOSITORY,
    });

    await expect(
      callerFor(user, authorityFor(null)).cloudEnvironments.list({ repository: REPOSITORY })
    ).resolves.toMatchObject([{ name: 'personal', repoFullName: REPOSITORY.fullName }]);
    await expect(
      callerFor(user, authorityFor(null)).cloudEnvironments.list({
        organizationId: organization.id,
        repository: REPOSITORY,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
