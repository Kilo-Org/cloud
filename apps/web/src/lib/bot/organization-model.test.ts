jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    isOrganizationModelUpdateAllowed: jest.fn(),
  })
);

jest.mock('@/lib/slack-bot/model-allow-list', () => ({
  getDefaultAllowedModel: jest.fn(),
}));

import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveOrganizationBotModel } from './organization-model';

const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';
const STORED_MODEL = 'anthropic/claude-sonnet-4.6';
const ORG_DEFAULT_MODEL = 'openai/gpt-5';

const mockedUpdateAllowed = jest.mocked(isOrganizationModelUpdateAllowed);
const mockedDefaultAllowedModel = jest.mocked(getDefaultAllowedModel);

beforeEach(() => {
  jest.resetAllMocks();
});

describe('resolveOrganizationBotModel', () => {
  it('keeps the stored model of a user-owned integration without reading organization policy', async () => {
    await expect(
      resolveOrganizationBotModel({ organizationId: null, storedModelSlug: STORED_MODEL })
    ).resolves.toBe(STORED_MODEL);

    expect(mockedUpdateAllowed).not.toHaveBeenCalled();
    expect(mockedDefaultAllowedModel).not.toHaveBeenCalled();
  });

  it('keeps a stored organization model the current policy still allows', async () => {
    mockedUpdateAllowed.mockResolvedValue(true);

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(STORED_MODEL);

    expect(mockedUpdateAllowed).toHaveBeenCalledWith(ORGANIZATION_ID, STORED_MODEL);
    expect(mockedDefaultAllowedModel).not.toHaveBeenCalled();
  });

  it('falls back to the allowed default when the policy no longer allows the stored model', async () => {
    mockedUpdateAllowed.mockResolvedValue(false);
    mockedDefaultAllowedModel.mockResolvedValue(ORG_DEFAULT_MODEL);

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBe(ORG_DEFAULT_MODEL);

    expect(mockedDefaultAllowedModel).toHaveBeenCalledWith(ORGANIZATION_ID, DEFAULT_BOT_MODEL);
  });

  it('resolves no model when the policy allows neither the stored model nor a default', async () => {
    mockedUpdateAllowed.mockResolvedValue(false);
    mockedDefaultAllowedModel.mockResolvedValue(null);

    await expect(
      resolveOrganizationBotModel({
        organizationId: ORGANIZATION_ID,
        storedModelSlug: STORED_MODEL,
      })
    ).resolves.toBeNull();
  });
});
