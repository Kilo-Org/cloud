import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import type * as endpointUpstream from '@/lib/byok/endpoint-upstream';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { byok_api_keys, organization_audit_logs } from '@kilocode/db/schema';
import type { Organization, User } from '@kilocode/db/schema';
import type {
  BYOKApiKeyEnvelope,
  ByokEndpointCredentials,
  ByokEndpointDefinition,
} from '@kilocode/db/schema-types';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  isFakeByokKmsRequest,
  TEST_BYOK_DATA_KEY,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';

let afterEndpointUrlCheck: (() => Promise<void>) | undefined;

jest.mock('@/lib/byok/endpoint-upstream', () => {
  const actual = jest.requireActual<typeof endpointUpstream>('@/lib/byok/endpoint-upstream');
  return {
    ...actual,
    findByokEndpointBaseUrlViolation: async (baseUrl: string) => {
      const violation = await actual.findByokEndpointBaseUrlViolation(baseUrl);
      await afterEndpointUrlCheck?.();
      return violation;
    },
  };
});

function decryptStoredKey(row: { encrypted_api_key_envelope: BYOKApiKeyEnvelope | null }): string {
  if (!row.encrypted_api_key_envelope) throw new Error('row has no envelope');
  return decryptApiKey(row.encrypted_api_key_envelope.encrypted_data, TEST_BYOK_DATA_KEY);
}

const DEFINITION: ByokEndpointDefinition = {
  name: 'Internal gateway',
  base_url: 'https://llm.example.com/v1',
  api_kinds: ['chat_completions'],
  client_provider: 'openrouter',
  reasoning_format: 'reasoning-details',
  models: [
    {
      id: 'my-model',
      internal_id: 'Org/My-Model',
      context_length: 100000,
      max_completion_tokens: 8000,
    },
  ],
};

const API_KEY_CREDENTIALS: ByokEndpointCredentials = {
  type: 'api_key',
  api_key: 'endpoint-secret',
};

type UpstreamCall = { url: string; init: RequestInit | undefined };

/** Answers every HTTPS fetch other than the fake KMS with `respond` and records it. */
function mockUpstream(respond: (url: string) => Response) {
  const calls: UpstreamCall[] = [];
  const fakeKms = globalThis.fetch;
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    // The data key cache reaches Redis over HTTP; it tolerates failures.
    if (isFakeByokKmsRequest(input) || !url.startsWith('https://')) return fakeKms(input, init);
    calls.push({ url, init });
    return respond(url);
  });
  return { calls, restore: () => spy.mockRestore() };
}

function headersOf(call: UpstreamCall | undefined) {
  return new Headers(call?.init?.headers);
}

function bodyOf(call: UpstreamCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body));
}

describe('BYOK endpoints', () => {
  useFakeByokKms();

  let owner: User;
  let member: User;
  let otherOwner: User;
  let organization: Organization;
  let otherOrganization: Organization;
  let restoreFetch: (() => void) | undefined;
  const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

  beforeAll(async () => {
    owner = await insertTestUser({ google_user_email: 'byok-endpoint-owner@example.com' });
    member = await insertTestUser({ google_user_email: 'byok-endpoint-member@example.com' });
    otherOwner = await insertTestUser({ google_user_email: 'byok-endpoint-other@example.com' });
    organization = await createTestOrganization('BYOK Endpoint Org', owner.id, 100000);
    otherOrganization = await createTestOrganization('BYOK Endpoint Other', otherOwner.id, 100000);
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    afterEndpointUrlCheck = undefined;
    process.env.VERCEL_TARGET_ENV = originalTargetEnv;
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organization.id));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, otherOrganization.id));
  });

  afterAll(() => {
    process.env.VERCEL_TARGET_ENV = originalTargetEnv;
  });

  async function createEndpoint(
    definition: ByokEndpointDefinition = DEFINITION,
    credentials: ByokEndpointCredentials = API_KEY_CREDENTIALS
  ) {
    const caller = await createCallerForUser(owner.id);
    return caller.byok.createEndpoint({ organizationId: organization.id, definition, credentials });
  }

  async function storedRow(id: string) {
    const [row] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, id));
    return row;
  }

  describe('createEndpoint', () => {
    test('stores the definition and the encrypted credentials, and lists the endpoint by name', async () => {
      const created = await createEndpoint();

      expect(created.provider_id).toMatch(/^endpoint-[a-z0-9]{10}$/);
      expect(created).toMatchObject({
        provider_name: 'Internal gateway',
        is_endpoint: true,
        endpoint: DEFINITION,
        supports_catalog_mode: true,
        serve_catalog_models: false,
      });
      const row = await storedRow(created.id);
      expect(row.settings.endpoint).toEqual(DEFINITION);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);

      const caller = await createCallerForUser(member.id);
      const [listed] = await caller.byok.list({ organizationId: organization.id });
      expect(listed).toMatchObject({
        id: created.id,
        provider_name: 'Internal gateway',
        is_endpoint: true,
        endpoint: null,
      });

      const ownerCaller = await createCallerForUser(owner.id);
      const [ownerListed] = await ownerCaller.byok.list({ organizationId: organization.id });
      expect(ownerListed).toMatchObject({ id: created.id, endpoint: DEFINITION });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id));
      expect(
        logs.some(
          log =>
            log.message === `Added BYOK endpoint Internal gateway (${created.provider_id})` &&
            log.actor_id === owner.id
        )
      ).toBe(true);
    });

    test('requires an organization', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.byok.createEndpoint({
          definition: DEFINITION,
          credentials: API_KEY_CREDENTIALS,
        } as unknown as Parameters<typeof caller.byok.createEndpoint>[0])
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('requires an owner or billing manager', async () => {
      const caller = await createCallerForUser(member.id);
      await expect(
        caller.byok.createEndpoint({
          organizationId: organization.id,
          definition: DEFINITION,
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('rejects a definition whose client API is not supported', async () => {
      await expect(
        createEndpoint({ ...DEFINITION, client_provider: 'anthropic' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test.each([
      ['http://llm.example.com/v1', 'The endpoint URL must use HTTPS.'],
      ['https://127.0.0.1/{model}/v1', 'The endpoint URL must point to a public host.'],
    ])('rejects %s where the URL policy applies', async (base_url, message) => {
      process.env.VERCEL_TARGET_ENV = 'production';
      await expect(createEndpoint({ ...DEFINITION, base_url })).rejects.toThrow(message);
    });

    test('is not accepted through the provider key procedures', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.byok.create({
          organizationId: organization.id,
          provider_id: 'endpoint-abcdefghij',
          api_key: 'secret',
        })
      ).rejects.toThrow('Endpoints are added with createEndpoint.');

      const created = await createEndpoint();
      await expect(
        caller.byok.update({ organizationId: organization.id, id: created.id, api_key: 'raw' })
      ).rejects.toThrow('Endpoints are updated with updateEndpoint.');
      expect(JSON.parse(decryptStoredKey(await storedRow(created.id)))).toEqual(
        API_KEY_CREDENTIALS
      );
    });
  });

  describe('updateEndpoint', () => {
    test('keeps the stored credentials when none are given', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, name: 'Renamed' };

      const updated = await caller.byok.updateEndpoint({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      expect(updated).toMatchObject({ provider_name: 'Renamed', endpoint: definition });
      const row = await storedRow(created.id);
      expect(row.settings.endpoint).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);
    });

    test('keeps catalog mode and the priority', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      await caller.byok.setCatalogMode({
        organizationId: organization.id,
        id: created.id,
        serve_catalog_models: true,
      });
      await caller.byok.reorder({ organizationId: organization.id, keyIds: [created.id] });
      const definition = { ...DEFINITION, name: 'Renamed' };

      const updated = await caller.byok.updateEndpoint({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      expect(updated).toMatchObject({ serve_catalog_models: true, endpoint: definition });
      expect((await storedRow(created.id)).settings).toEqual({
        serve_catalog_models: true,
        priority: 0,
        endpoint: definition,
      });
    });

    test('replaces the credentials when given', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      const credentials: ByokEndpointCredentials = { type: 'x-api-key', api_key: 'new-secret' };

      await caller.byok.updateEndpoint({
        organizationId: organization.id,
        id: created.id,
        definition: DEFINITION,
        credentials,
      });

      expect(JSON.parse(decryptStoredKey(await storedRow(created.id)))).toEqual(credentials);
    });

    test('requires credentials when the host changes', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, base_url: 'https://attacker.example.com/v1' };

      await expect(
        caller.byok.updateEndpoint({ organizationId: organization.id, id: created.id, definition })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Enter the credentials again to use a different host',
      });
      expect((await storedRow(created.id)).settings.endpoint).toEqual(DEFINITION);

      const credentials: ByokEndpointCredentials = { type: 'api_key', api_key: 'new-host-secret' };
      await caller.byok.updateEndpoint({
        organizationId: organization.id,
        id: created.id,
        definition,
        credentials,
      });
      const row = await storedRow(created.id);
      expect(row.settings.endpoint).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(credentials);
    });

    test('conflicts when the stored host changed after the host check', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      const changed = { ...DEFINITION, base_url: 'https://attacker.example.com/v1' };
      afterEndpointUrlCheck = async () => {
        await db
          .update(byok_api_keys)
          .set({ settings: { endpoint: changed } })
          .where(eq(byok_api_keys.id, created.id));
      };

      await expect(
        caller.byok.updateEndpoint({
          organizationId: organization.id,
          id: created.id,
          definition: { ...DEFINITION, base_url: 'https://llm.example.com/v2' },
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The endpoint changed; reload and try again',
      });
      expect((await storedRow(created.id)).settings.endpoint).toEqual(changed);
    });

    test('keeps the stored credentials when only the path changes', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, base_url: 'https://llm.example.com/v2' };

      await caller.byok.updateEndpoint({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      const row = await storedRow(created.id);
      expect(row.settings.endpoint).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);
    });

    test('only updates endpoints of the organization', async () => {
      const created = await createEndpoint();
      const providerKey = await (
        await createCallerForUser(owner.id)
      ).byok.create({ organizationId: organization.id, provider_id: 'anthropic', api_key: 'k' });
      const otherCaller = await createCallerForUser(otherOwner.id);
      const ownerCaller = await createCallerForUser(owner.id);

      await expect(
        otherCaller.byok.updateEndpoint({
          organizationId: otherOrganization.id,
          id: created.id,
          definition: DEFINITION,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        ownerCaller.byok.updateEndpoint({
          organizationId: organization.id,
          id: providerKey.id,
          definition: DEFINITION,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('stored definitions', () => {
    test('lists an endpoint whose definition no longer parses without it', async () => {
      const created = await createEndpoint();
      await db
        .update(byok_api_keys)
        .set({ settings: { priority: 3, endpoint: { name: 'Broken' } } as never })
        .where(eq(byok_api_keys.id, created.id));
      const caller = await createCallerForUser(owner.id);

      const [listed] = await caller.byok.list({ organizationId: organization.id });

      expect(listed).toMatchObject({ id: created.id, is_endpoint: true, endpoint: null });
      expect(listed.provider_name).not.toBe('Broken');
    });

    test('ignores an endpoint definition in the settings of a provider key', async () => {
      const caller = await createCallerForUser(owner.id);
      const providerKey = await caller.byok.create({
        organizationId: organization.id,
        provider_id: 'anthropic',
        api_key: 'k',
      });
      await db
        .update(byok_api_keys)
        .set({ settings: { endpoint: DEFINITION } })
        .where(eq(byok_api_keys.id, providerKey.id));

      const [listed] = await caller.byok.list({ organizationId: organization.id });

      expect(listed).toMatchObject({ id: providerKey.id, is_endpoint: false, endpoint: null });
      expect(listed.provider_name).not.toBe(DEFINITION.name);
    });
  });

  test('listEndpointCatalogModelIds is limited to roles that manage keys', async () => {
    const memberCaller = await createCallerForUser(member.id);
    await expect(
      memberCaller.byok.listEndpointCatalogModelIds({
        organizationId: organization.id,
        modelIds: ['my-model'],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const ownerCaller = await createCallerForUser(owner.id);
    await expect(
      ownerCaller.byok.listEndpointCatalogModelIds({
        organizationId: organization.id,
        modelIds: [],
      })
    ).resolves.toEqual([]);
  });

  test('setCatalogMode turns catalog mode on for an endpoint', async () => {
    const created = await createEndpoint();
    const caller = await createCallerForUser(owner.id);

    const updated = await caller.byok.setCatalogMode({
      organizationId: organization.id,
      id: created.id,
      serve_catalog_models: true,
    });

    expect(updated).toMatchObject({ serve_catalog_models: true, can_change_catalog_mode: true });
  });

  describe('listModelsFromEndpoint', () => {
    const MODELS_RESPONSE = {
      data: [{ id: 'Org/My-Model', name: 'My Model', context_length: 64000 }],
    };

    test('lists the models with the given credentials', async () => {
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      const result = await caller.byok.listModelsFromEndpoint({
        organizationId: organization.id,
        base_url: 'https://llm.example.com/v1',
        credentials: API_KEY_CREDENTIALS,
      });

      expect(result.models).toEqual([
        {
          id: 'org/my-model',
          internal_id: 'Org/My-Model',
          name: 'My Model',
          context_length: 64000,
          max_completion_tokens: 32000,
          flags: ['reasoning'],
        },
      ]);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0].url).toBe('https://llm.example.com/v1/models');
      expect(upstream.calls[0].init).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(headersOf(upstream.calls[0]).get('authorization')).toBe('Bearer endpoint-secret');
    });

    test('uses the stored credentials of an endpoint', async () => {
      const created = await createEndpoint(DEFINITION, { type: 'x-api-key', api_key: 'stored' });
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.listModelsFromEndpoint({
        organizationId: organization.id,
        base_url: 'https://llm.example.com/other/v2',
        id: created.id,
      });

      const headers = headersOf(upstream.calls[0]);
      expect(upstream.calls[0].url).toBe('https://llm.example.com/other/v2/models');
      expect(headers.get('x-api-key')).toBe('stored');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.has('authorization')).toBe(false);
    });

    test.each([
      ['another host', 'https://attacker.example.com/v1'],
      ['another port', 'https://llm.example.com:8443/v1'],
      ['another scheme', 'http://llm.example.com/v1'],
      ['a host that only looks the same', 'https://llm.example.com.attacker.example/v1'],
    ])('does not send the stored credentials to %s', async (_case, base_url) => {
      const created = await createEndpoint();
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.listModelsFromEndpoint({
          organizationId: organization.id,
          base_url,
          id: created.id,
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Enter the credentials again to use a different host',
      });
      expect(upstream.calls).toHaveLength(0);
    });

    test('compares the host of a per-model URL with the {model} placeholder filled in', async () => {
      const created = await createEndpoint({
        ...DEFINITION,
        base_url: 'https://llm.example.com/{model}/v1',
      });
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.listModelsFromEndpoint({
        organizationId: organization.id,
        base_url: 'https://llm.example.com/v1',
        id: created.id,
      });

      expect(upstream.calls).toHaveLength(1);
    });

    test('signs AWS requests with SigV4', async () => {
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.listModelsFromEndpoint({
        organizationId: organization.id,
        base_url: 'https://bedrock-mantle.us-east-1.api.aws/v1',
        credentials: {
          type: 'aws_bedrock',
          region: 'us-east-1',
          access_key_id: 'AKIAEXAMPLE',
          secret_access_key: 'secret',
        },
      });

      expect(headersOf(upstream.calls[0]).get('authorization')).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/
      );
    });

    test('does not read another organization endpoint credentials', async () => {
      const created = await createEndpoint();
      const caller = await createCallerForUser(otherOwner.id);

      await expect(
        caller.byok.listModelsFromEndpoint({
          organizationId: otherOrganization.id,
          base_url: 'https://llm.example.com/v1',
          id: created.id,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test.each([
      [
        'a per-model URL',
        'https://llm.example.com/{model}/v1',
        () => Response.json(MODELS_RESPONSE),
        'Models cannot be imported when the base URL contains {model}',
      ],
      [
        'a rejected key',
        'https://llm.example.com/v1',
        () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }),
        'The endpoint could not list its models: HTTP 401: Invalid API key',
      ],
      [
        'a redirect',
        'https://llm.example.com/v1',
        () => new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/' } }),
        'The endpoint responded with a redirect',
      ],
    ])('reports %s', async (_case, base_url, respond, message) => {
      const upstream = mockUpstream(respond);
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.listModelsFromEndpoint({
          organizationId: organization.id,
          base_url,
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toThrow(message);
    });
  });

  describe('testApiKey', () => {
    test('sends a Chat Completions request to the first model', async () => {
      const created = await createEndpoint();
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({
        success: true,
        message: 'API key test success. Endpoint: Internal gateway. Model: my-model.',
      });
      expect(upstream.calls[0].url).toBe('https://llm.example.com/v1/chat/completions');
      expect(headersOf(upstream.calls[0]).get('authorization')).toBe('Bearer endpoint-secret');
      expect(bodyOf(upstream.calls[0])).toMatchObject({
        model: 'Org/My-Model',
        messages: [{ role: 'user', content: 'Say hi' }],
        max_tokens: 256,
      });
    });

    test('retries with max_completion_tokens when the upstream asks for it', async () => {
      const created = await createEndpoint();
      let attempt = 0;
      const upstream = mockUpstream(() =>
        ++attempt === 1
          ? Response.json(
              {
                error: {
                  message:
                    "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
                },
              },
              { status: 400 }
            )
          : Response.json({ choices: [] })
      );
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toMatchObject({ success: true });
      expect(bodyOf(upstream.calls[1])).toMatchObject({ max_completion_tokens: 256 });
      expect(bodyOf(upstream.calls[1])).not.toHaveProperty('max_tokens');
    });

    test('sends a Chat Completions request with the model in the URL to a chosen model', async () => {
      const created = await createEndpoint({
        ...DEFINITION,
        base_url: 'https://llm.example.com/models/{model}',
        models: [
          ...DEFINITION.models,
          {
            id: 'claude',
            internal_id: 'claude/sonnet',
            context_length: 200000,
            max_completion_tokens: 64000,
          },
        ],
      });
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({
          organizationId: organization.id,
          id: created.id,
          modelId: 'claude',
        })
      ).resolves.toMatchObject({ success: true });
      expect(upstream.calls[0].url).toBe(
        'https://llm.example.com/models/claude%2Fsonnet/chat/completions'
      );
      expect(bodyOf(upstream.calls[0])).not.toHaveProperty('model');
    });

    test('rejects the {model} placeholder for an endpoint serving Messages', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.createEndpoint({
          organizationId: organization.id,
          definition: {
            ...DEFINITION,
            base_url: 'https://llm.example.com/models/{model}',
            api_kinds: ['chat_completions', 'messages'],
          },
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toThrow('only supported for Chat Completions');
    });

    test('reports the upstream error', async () => {
      const created = await createEndpoint();
      const upstream = mockUpstream(() =>
        Response.json({ error: { message: 'model not found' } }, { status: 404 })
      );
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({
        success: false,
        message: 'API key test failed: HTTP 404: model not found',
      });
    });
  });

  test('deleting an endpoint removes it', async () => {
    const created = await createEndpoint();
    const caller = await createCallerForUser(owner.id);

    await caller.byok.delete({ organizationId: organization.id, id: created.id });

    const rows = await db
      .select()
      .from(byok_api_keys)
      .where(and(eq(byok_api_keys.organization_id, organization.id)));
    expect(rows).toEqual([]);
  });
});
