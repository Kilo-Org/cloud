import { describe, it, expect, beforeEach } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { checkDirectProviderAccess } from '@kilocode/web-shared/lib/ai-gateway/direct-provider-access';

jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { name: 'primary' },
  readDb: { name: 'replica' },
}));

const mockedIsFreeModel = jest.mocked(isFreeModel);
const mockedGetBalance = jest.mocked(getBalanceAndOrgSettings);
const mockedDecision = jest.mocked(resolveOrganizationMemberModelDecision);

const user = { id: 'user-1' } as User;
const payer = { kind: 'organization', id: 'org-1' } as never;

function params(overrides: Partial<Parameters<typeof checkDirectProviderAccess>[0]> = {}) {
  return {
    user,
    organizationId: 'org-1',
    model: 'vendor/model',
    provider: 'inception',
    isFreeUsage: false,
    hasByok: false,
    ...overrides,
  };
}

function decide(decision: { allowed: boolean; eligibleProviderRoutes?: ReadonlySet<string> }) {
  mockedDecision.mockResolvedValue({ decision } as Awaited<
    ReturnType<typeof resolveOrganizationMemberModelDecision>
  >);
}

describe('checkDirectProviderAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsFreeModel.mockResolvedValue(false);
    mockedGetBalance.mockResolvedValue({ balance: 10, plan: 'teams', payer, settings: undefined });
    decide({ allowed: true });
  });

  it('reads paid balance from the replica with usage funding', async () => {
    const result = await checkDirectProviderAccess(params());
    expect(mockedIsFreeModel).toHaveBeenCalledWith('vendor/model');
    expect(mockedGetBalance.mock.calls).toEqual([['org-1', user, readDb, 'usage']]);
    const [decisionParams] = mockedDecision.mock.calls[0];
    expect(decisionParams.fromDb).toBe(readDb);
    expect(decisionParams).toMatchObject({
      organizationId: 'org-1',
      kiloUserId: 'user-1',
      modelId: 'vendor/model',
    });
    expect(result).toEqual({ access: { balance: 10, plan: 'teams', payer } });
  });

  it('omits usage funding for free models', async () => {
    mockedIsFreeModel.mockResolvedValue(true);
    await checkDirectProviderAccess(params({ organizationId: undefined }));
    expect(mockedGetBalance.mock.calls).toEqual([[undefined, user, readDb, undefined]]);
  });

  it('rejects insufficient paid balance with a plain 402 before the model decision', async () => {
    mockedGetBalance.mockResolvedValue({ balance: 0, settings: undefined });
    decide({ allowed: false });
    const result = await checkDirectProviderAccess(params());
    expect(result.rejection?.status).toBe(402);
    await expect(result.rejection?.json()).resolves.toEqual({
      error: { message: 'Insufficient credits' },
      error_type: ProxyErrorType.insufficient_credits,
    });
    expect(mockedDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['free usage', { isFreeUsage: true }],
    ['BYOK', { hasByok: true }],
  ])('allows insufficient balance for %s', async (_label, overrides) => {
    mockedGetBalance.mockResolvedValue({ balance: 0, settings: undefined });
    const result = await checkDirectProviderAccess(params(overrides));
    expect(result).toEqual({ access: { balance: 0, plan: undefined, payer: undefined } });
  });

  it('skips the model decision without an organization', async () => {
    const result = await checkDirectProviderAccess(params({ organizationId: undefined }));
    expect(mockedDecision).not.toHaveBeenCalled();
    expect(result.access).toBeDefined();
  });

  it('rejects a disallowed model', async () => {
    decide({ allowed: false });
    const result = await checkDirectProviderAccess(params());
    expect(result.rejection?.status).toBe(404);
  });

  it.each([
    ['restricted routes without the provider', new Set(['mistral']), false],
    ['empty routes', new Set<string>(), false],
    ['routes including the provider', new Set(['inception']), true],
    ['unrestricted routes', undefined, true],
  ])('handles %s', async (_label, eligibleProviderRoutes, allowed) => {
    decide({ allowed: true, eligibleProviderRoutes });
    const result = await checkDirectProviderAccess(params());
    expect(result.access !== undefined).toBe(allowed);
    if (!allowed) expect(result.rejection?.status).toBe(404);
  });
});
