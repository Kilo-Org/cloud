import { generateMock } from '@anatine/zod-mock';
import type {
  OrganizationWithMembers,
  OrganizationMember,
} from '@/lib/organizations/organization-types';
import { OrganizationSchema } from '@/lib/organizations/organization-types';
import { mockDataRng as rng, randomChoice, randomBoolean, randomId, randomInt } from './random';
import { COMPANY_TYPES, ORG_ROLES, ORG_STATUSES } from './constants';

function generateMember(): OrganizationMember {
  const role = randomChoice(rng, ORG_ROLES);
  const dailyUsageLimitUsd = randomBoolean(rng, 0.5) ? rng() * 1000 : null;
  const currentDailyUsageUsd = dailyUsageLimitUsd ? rng() * dailyUsageLimitUsd : null;
  const status = randomChoice(rng, ORG_STATUSES);

  if (status === 'active') {
    return {
      id: randomId(rng, 'user'),
      name: `User ${randomInt(rng, 0, 999)}`,
      email: `user${randomInt(rng, 0, 999)}@example.com`,
      role,
      status: 'active',
      inviteDate: randomBoolean(rng, 0.5) ? new Date().toISOString() : null,
      dailyUsageLimitUsd,
      currentDailyUsageUsd,
    };
  }

  return {
    email: `invited${randomInt(rng, 0, 999)}@example.com`,
    role,
    inviteDate: new Date().toISOString(),
    inviteToken: Math.floor(rng() * 36 ** 32).toString(36),
    inviteId: randomId(rng, 'invite'),
    status: 'invited',
    inviteUrl: `https://app.example.com/invite/${Math.floor(rng() * 36 ** 16).toString(36)}`,
    dailyUsageLimitUsd,
    currentDailyUsageUsd,
  };
}

export function generateOrganization(): OrganizationWithMembers {
  const base = generateMock(OrganizationSchema);
  const companyType = randomChoice(rng, COMPANY_TYPES);

  return {
    ...base,
    name: `Company ${randomInt(rng, 0, 999)} ${companyType}`,
    members: Array.from({ length: randomInt(rng, 2, 7) }, generateMember),
  };
}

export const mockOrganization = generateOrganization();
