import type { StoredModel, User } from '@kilocode/db';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));

import { GET } from './route';

const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockGetOpenRouterModels = jest.mocked(getOpenRouterModelsMetadataFromDatabase);

function storedModel(id: string, name: string, outputModalities: string[]): StoredModel {
  return {
    id,
    name,
    architecture: { output_modalities: outputModalities },
    endpoints: [{ provider_name: 'test' }],
  };
}

describe('GET /admin/api/auto-routing/system-one-models', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({
      user: { id: 'admin_123' } as Partial<User> as User,
      authFailedResponse: null,
    });
  });

  it('returns only System One models from the stored OpenRouter catalog', async () => {
    mockGetOpenRouterModels.mockResolvedValue({
      'typesafe/jev-1.13': storedModel('typesafe/jev-1.13', 'TypeSafe: Jev 1.13', ['decisions']),
      'google/gemini-2.5-flash-lite': storedModel(
        'google/gemini-2.5-flash-lite',
        'Google: Gemini 2.5 Flash Lite',
        ['text']
      ),
      'cloudflare/clef': storedModel('cloudflare/clef', 'Cloudflare: Clef', ['decisions']),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        { id: 'cloudflare/clef', name: 'Cloudflare: Clef' },
        { id: 'typesafe/jev-1.13', name: 'TypeSafe: Jev 1.13' },
      ],
    });
  });
});
