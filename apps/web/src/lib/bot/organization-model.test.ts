jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    resolveOrganizationDefaultModelPolicy: jest.fn(),
    getEffectiveModelDecision: jest.fn(),
  })
);

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(),
}));

import { TRPCError } from '@trpc/server';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveOrganizationBotModel } from './organization-model';

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';
const STORED_MODEL = 'anthropic/claude-sonnet-4.6';
const ORG_DEFAULT_MODEL = 'openai/gpt-5';

const mockedPolicy = jest.mocked(resolveOrganizationDefaultModelPolicy);
const mockedDecision = jest.mocked(getEffectiveModelDecision);
const mockedDefaultAllowedModel = jest.mocked(getDefaultAllowedModel);

const policy = { memberGrant: { mode: 'unrestricted' } } as EffectiveOrganizationModelPolicy;

beforeEach(() => {
  jest.resetAllMocks();
  mockedPolicy.mockResolvedValue(policy);
});

describe('resolveOrganizationBotModel', () => {
  it('keeps the stored model of a user-owned integration without reading organization policy', async () => {
    await expect(
      resolveOrganizationBotModel({ organizationId: null, storedModelSlug: STORED_MODEL })
    ).resolves.toBe(STORED_MODEL);

    expect(mockedPolicy).not.toHaveBeenCalled();
    expect(mockedDecision).not.toHaveBeenCalled();
    expect(mockedDefaultAllowedModel).not.toHaveBeenCalled();
  });

  it('keeps a stored organization model the current policy allows', async () => {
    mockedDecision.mockResolvedValue({ allowed: true });

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(STORED_MODEL);

    expect(mockedPolicy).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    expect(mockedDecision).toHaveBeenCalledWith(policy, STORED_MODEL);
    expect(mockedDefaultAllowedModel).not.toHaveBeenCalled();
  });

  it('falls back to the allowed default when the policy does not allow the stored model', async () => {
    mockedDecision.mockResolvedValue({ allowed: false, denialSource: 'no_grant' });
    mockedDefaultAllowedModel.mockResolvedValue(ORG_DEFAULT_MODEL);

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(ORG_DEFAULT_MODEL);

    expect(mockedDefaultAllowedModel).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      DEFAULT_BOT_MODEL,
      policy
    );
  });

  it('uses the bot default when the allowed-default resolution returns no model', async () => {
    mockedDecision.mockResolvedValue({ allowed: false, denialSource: 'no_grant' });
    mockedDefaultAllowedModel.mockResolvedValue(null);

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(DEFAULT_BOT_MODEL);
  });

  it('keeps the stored model when the organization no longer exists', async () => {
    mockedPolicy.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(STORED_MODEL);

    expect(mockedDefaultAllowedModel).not.toHaveBeenCalled();
  });

  it('propagates a policy read failure', async () => {
    mockedPolicy.mockRejectedValue(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }));

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).rejects.toThrow(TRPCError);
  });
});
