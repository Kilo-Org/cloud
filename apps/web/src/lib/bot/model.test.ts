jest.mock('@/lib/bot/organization-model', () => ({
  resolveOrganizationBotModel: jest.fn(),
}));

import { resolveOrganizationBotModel } from '@/lib/bot/organization-model';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveBotModelSlug, resolveBotRunModel } from './model';

const mockedResolveOrganizationBotModel = jest.mocked(resolveOrganizationBotModel);
const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';

describe('resolveBotModelSlug', () => {
  it('returns a trimmed configured bot model slug', () => {
    expect(resolveBotModelSlug({ metadata: { model_slug: '  z-ai/glm-5.2  ' } })).toBe(
      'z-ai/glm-5.2'
    );
  });

  it.each([
    { name: 'null integration', integration: null },
    { name: 'undefined integration', integration: undefined },
    { name: 'missing metadata', integration: { metadata: undefined } },
    { name: 'missing model slug', integration: { metadata: {} } },
    { name: 'empty model slug', integration: { metadata: { model_slug: '' } } },
    { name: 'whitespace model slug', integration: { metadata: { model_slug: '   ' } } },
    { name: 'non-string model slug', integration: { metadata: { model_slug: 42 } } },
    { name: 'non-object metadata', integration: { metadata: 'z-ai/glm-5.2' } },
  ])('falls back to the default bot model for $name', ({ integration }) => {
    expect(resolveBotModelSlug(integration)).toBe(DEFAULT_BOT_MODEL);
  });
});

describe('resolveBotRunModel', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('resolves a user-owned integration to its stored model', async () => {
    mockedResolveOrganizationBotModel.mockResolvedValue('user/stored-model');

    await expect(
      resolveBotRunModel({ metadata: { model_slug: 'user/stored-model' } })
    ).resolves.toBe('user/stored-model');

    expect(mockedResolveOrganizationBotModel).toHaveBeenCalledWith({
      organizationId: null,
      storedModelSlug: 'user/stored-model',
    });
  });

  it('evaluates an organization-owned integration against the organization policy', async () => {
    mockedResolveOrganizationBotModel.mockResolvedValue('org/allowed-model');

    await expect(
      resolveBotRunModel({
        metadata: { model_slug: 'org/stored-model' },
        owned_by_organization_id: ORGANIZATION_ID,
      })
    ).resolves.toBe('org/allowed-model');

    expect(mockedResolveOrganizationBotModel).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      storedModelSlug: 'org/stored-model',
    });
  });

  it('resolves an organization integration without a stored model to the bot default', async () => {
    mockedResolveOrganizationBotModel.mockResolvedValue(DEFAULT_BOT_MODEL);

    await expect(
      resolveBotRunModel({ metadata: {}, owned_by_organization_id: ORGANIZATION_ID })
    ).resolves.toBe(DEFAULT_BOT_MODEL);

    expect(mockedResolveOrganizationBotModel).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      storedModelSlug: DEFAULT_BOT_MODEL,
    });
  });
});
