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
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';

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

  test('no deny list returns PRIMARY_DEFAULT_MODEL without calling OpenRouter', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockRejectedValue(new Error('should not be called'));

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          settings: {},
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultModel).toBe(PRIMARY_DEFAULT_MODEL);
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  test('deny list blocking PRIMARY_DEFAULT_MODEL falls back to first non-denied model from OpenRouter', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockResolvedValue({
      data: [
        makeOpenRouterModel(PRIMARY_DEFAULT_MODEL),
        makeOpenRouterModel('openai/gpt-4o'),
        makeOpenRouterModel('example-provider/model-1'),
      ],
    });

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          plan: 'enterprise' as const,
          settings: {
            model_deny_list: [PRIMARY_DEFAULT_MODEL],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    // Should return the first non-denied model from OpenRouter
    expect(body.defaultModel).toBe('openai/gpt-4o');
  });

  test('org-configured default model is returned when not in deny list', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockRejectedValue(new Error('should not be called'));
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          plan: 'enterprise' as const,
          settings: {
            default_model: 'openai/gpt-4o',
            model_deny_list: ['anthropic/claude-3-opus'],
          },
        },
      },
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: organization.id }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.defaultModel).toBe('openai/gpt-4o');
    expect(mockedGetEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  test('returns 409 when all models are denied', async () => {
    const user = await insertTestUser();
    const organization = await createOrganization('Test Org', user.id);

    mockedGetEnhancedOpenRouterModels.mockResolvedValue({ data: [] });

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        user: { ...user, role: 'owner' },
        organization: {
          ...organization,
          plan: 'enterprise' as const,
          settings: {
            model_deny_list: [PRIMARY_DEFAULT_MODEL],
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
      error:
        "No valid models are available — all models are blocked by this organization's deny list.",
    });
  });
});
