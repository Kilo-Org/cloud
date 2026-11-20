/**
 * Model validation and the model catalog answer one organization member the same way.
 * The organization policy code runs for real here; only the upstream catalog is faked.
 */
const mockHeaders = jest.fn(() => currentHeaders);
let currentHeaders = new Headers();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));
jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: jest.fn(async () => null),
}));
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/openrouter'),
  getEnhancedOpenRouterModels: jest.fn(),
}));
// The provider index is an upstream snapshot; a test database has none, and both
// endpoints read it the same way.
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getProviderSlugsForModel: jest.fn(async () => new Set(['openai'])),
    getProviderSlugsForModels: jest.fn(async (ids: readonly string[]) => {
      return new Map(ids.map(id => [id, new Set(['openai'])]));
    }),
  })
);

import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { POST as personalValidate } from './models/validate/route';
import { GET as catalog } from './models/route';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { generateApiToken, generateOrganizationApiToken } from '@kilocode/web-shared/lib/tokens';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { auto_routing_custom_routers } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const { getEnhancedOpenRouterModels } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter'
);

const deniedModel = 'test/denied-model';
const allowedModel = 'test/allowed-model';

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'test' },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
    supported_parameters: ['tools'],
  };
}

const catalogModels = [makeModel(allowedModel), makeModel(deniedModel)];

function validateRequest(modelId: string) {
  return new NextRequest('http://localhost:3000/api/openrouter/models/validate', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
  });
}

async function validate(modelId: string) {
  const response = await personalValidate(validateRequest(modelId));
  return { status: response.status, body: await response.json() };
}

async function catalogModelIds(): Promise<string[]> {
  const response = await catalog(new NextRequest('http://localhost:3000/api/openrouter/models'));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map(model => model.id);
}

describe('model validation agrees with the catalog for one credential', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentHeaders = new Headers();
    getEnhancedOpenRouterModels.mockResolvedValue({ data: catalogModels });
  });

  test('an organization member gets the organization answer from both endpoints', async () => {
    const member = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const organization = await createTestOrganization(
      'model validation agreement',
      member.id,
      0,
      { model_deny_list: [deniedModel] },
      false
    );
    await addUserToOrganization(organization.id, member.id, 'member');
    const { token } = generateOrganizationApiToken(member, organization.id, 'member');
    currentHeaders = new Headers({ authorization: `Bearer ${token}` });

    const availableIds = await catalogModelIds();
    expect(availableIds).toContain(allowedModel);
    expect(availableIds).not.toContain(deniedModel);

    await expect(validate(allowedModel)).resolves.toEqual({
      status: 200,
      body: { valid: true },
    });
    await expect(validate(deniedModel)).resolves.toEqual({
      status: 200,
      body: { valid: false, reason: 'unavailable' },
    });
  });

  test('an organization custom router agrees with the catalog', async () => {
    const member = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const organization = await createTestOrganization(
      'model validation router',
      member.id,
      0,
      {},
      false
    );
    await addUserToOrganization(organization.id, member.id, 'member');
    const slug = `router-${crypto.randomUUID()}`;
    await db.insert(auto_routing_custom_routers).values({
      owned_by_organization_id: organization.id,
      slug,
      name: 'Router',
      base_router: 'efficient',
      mode: 'best_accuracy',
      entries: [{ kind: 'gateway', model: allowedModel }],
      default_entry_key: `gateway:${allowedModel}`,
    });
    const { token } = generateOrganizationApiToken(member, organization.id, 'member');
    currentHeaders = new Headers({ authorization: `Bearer ${token}` });

    const routerModelId = `kilo-auto/custom/org/${slug}`;
    const availableIds = await catalogModelIds();
    expect(availableIds).toContain(routerModelId);

    await expect(validate(routerModelId)).resolves.toEqual({
      status: 200,
      body: { valid: true },
    });

    await db.delete(auto_routing_custom_routers).where(eq(auto_routing_custom_routers.slug, slug));
  });

  test('a personal credential keeps the personal answer', async () => {
    const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
    const organization = await createTestOrganization(
      'model validation personal',
      user.id,
      0,
      { model_deny_list: [deniedModel] },
      false
    );
    await addUserToOrganization(organization.id, user.id, 'member');
    currentHeaders = new Headers({ authorization: `Bearer ${generateApiToken(user)}` });

    await expect(validate(deniedModel)).resolves.toEqual({
      status: 200,
      body: { valid: true },
    });
  });
});
