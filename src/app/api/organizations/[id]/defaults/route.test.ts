import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import { kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

jest.mock('@/lib/organizations/organization-auth');
jest.mock('@/lib/providers/openrouter');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);
const mockedGetEnhancedOpenRouterModels = jest.mocked(getEnhancedOpenRouterModels);

function makeOpenRouterModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: [],
      output_modalities: [],
      tokenizer: 'test',
    },
    top_provider: {
      is_moderated: false,
      context_length: null,
      max_completion_tokens: null,
    },
    pricing: {
      prompt: '0',
      completion: '0',
    },
    context_length: 0,
    per_request_limits: null,
    supported_parameters: [],
  };
}

describe('GET /api/organizations/[id]/defaults', () => {
  beforeEach(() => {
    mockedGetAuthorizedOrgContext.mockReset();
    mockedGetEnhancedOpenRouterModels.mockReset();
  });

  afterEach(async () => {
    // Clean up in FK-safe order
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('wildcard-only allow list returns an allowed preferred model (does not fall back to a disallowed global default)', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockRejectedValue(new Error('should not be called'));

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          settings: {
            model_allow_list: ['openai/*'],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // The response must be a concrete model id (not the disallowed global default).
    expect(body.defaultModel).toMatch(/^openai\//);
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  test('wildcard-only allow list falls back to the first allowed OpenRouter model when no preferred model matches', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [
        makeOpenRouterModel('example-provider/model-1'),
        makeOpenRouterModel('some-other/model-2'),
      ],
    });

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          settings: {
            model_allow_list: ['example-provider/*'],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultModel).toBe('example-provider/model-1');
    expect(mockedGetEnhancedOpenRouterModels).toHaveBeenCalledTimes(1);
  });

  test('falls back to the first concrete allow-list entry when no global default is allowed', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockRejectedValue(new Error('should not be called'));

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          settings: {
            model_allow_list: ['openai/gpt-5.2', 'openai/*'],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultModel).toBe('openai/gpt-5.2');
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  test('returns 409 when allow list exists but no models are allowed by it', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockResolvedValue({ data: [] });

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          settings: {
            model_allow_list: ['no-such-provider/*'],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      error: "No valid models are allowed by this organization's allow list.",
    });
    expect(mockedGetEnhancedOpenRouterModels).toHaveBeenCalledTimes(1);
  });
});
