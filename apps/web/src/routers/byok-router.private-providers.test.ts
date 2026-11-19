import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import type * as privateProviderUpstream from '@/lib/byok/private-provider-upstream';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, byok_api_keys, organization_audit_logs } from '@kilocode/db/schema';
import type { Organization, User } from '@kilocode/db/schema';
import type {
  BYOKApiKeyEnvelope,
  ByokPrivateProviderCredentials,
  ByokPrivateProviderDefinition,
} from '@kilocode/db/schema-types';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  isFakeByokKmsRequest,
  TEST_BYOK_DATA_KEY,
  testByokEnvelope,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';

let afterPrivateProviderUrlCheck: (() => Promise<void>) | undefined;

jest.mock('@/lib/byok/private-provider-upstream', () => {
  const actual = jest.requireActual<typeof privateProviderUpstream>(
    '@/lib/byok/private-provider-upstream'
  );
  return {
    ...actual,
    findByokPrivateProviderBaseUrlViolation: async (baseUrl: string) => {
      const violation = await actual.findByokPrivateProviderBaseUrlViolation(baseUrl);
      await afterPrivateProviderUrlCheck?.();
      return violation;
    },
  };
});

function decryptStoredKey(row: { encrypted_api_key_envelope: BYOKApiKeyEnvelope | null }): string {
  if (!row.encrypted_api_key_envelope) throw new Error('row has no envelope');
  return decryptApiKey(row.encrypted_api_key_envelope.encrypted_data, TEST_BYOK_DATA_KEY);
}

const DEFINITION: ByokPrivateProviderDefinition = {
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

const PRIVATE_PROVIDER_API_KEY = 'private-provider-secret';

async function enableByokPrivateProviders(organizationIds: string[]) {
  const config = { organization_features: { byok_private_providers: organizationIds } };
  await db
    .insert(ai_gateway_config)
    .values({ config })
    .onConflictDoUpdate({ target: ai_gateway_config.id, set: { config } });
}

const API_KEY_CREDENTIALS: ByokPrivateProviderCredentials = {
  type: 'api_key',
  api_key: PRIVATE_PROVIDER_API_KEY,
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

describe('BYOK private providers', () => {
  useFakeByokKms();

  let owner: User;
  let member: User;
  let otherOwner: User;
  let organization: Organization;
  let otherOrganization: Organization;
  let restoreFetch: (() => void) | undefined;
  const originalNodeEnv = process.env.NODE_ENV;
  /** The upstream URL policy applies outside development and tests (`isUpstreamUrlPolicyEnforced`). */
  const setNodeEnv = (value: string | undefined) => {
    const env: Record<string, string | undefined> = process.env;
    if (value === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = value;
  };

  beforeAll(async () => {
    owner = await insertTestUser({ google_user_email: 'byok-private-provider-owner@example.com' });
    member = await insertTestUser({
      google_user_email: 'byok-private-provider-member@example.com',
    });
    otherOwner = await insertTestUser({
      google_user_email: 'byok-private-provider-other@example.com',
    });
    organization = await createTestOrganization('BYOK Private provider Org', owner.id, 100000);
    otherOrganization = await createTestOrganization(
      'BYOK Private provider Other',
      otherOwner.id,
      100000
    );
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  beforeEach(() => enableByokPrivateProviders([organization.id, otherOrganization.id]));

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    afterPrivateProviderUrlCheck = undefined;
    setNodeEnv(originalNodeEnv);
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organization.id));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, otherOrganization.id));
  });

  afterAll(async () => {
    setNodeEnv(originalNodeEnv);
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  });

  async function createPrivateProvider(
    definition: ByokPrivateProviderDefinition = DEFINITION,
    credentials: ByokPrivateProviderCredentials = API_KEY_CREDENTIALS
  ) {
    const caller = await createCallerForUser(owner.id);
    return caller.byok.createPrivateProvider({
      organizationId: organization.id,
      definition,
      credentials,
    });
  }

  async function storedRow(id: string) {
    const [row] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, id));
    return row;
  }

  describe('feature toggle', () => {
    const UNAVAILABLE = 'BYOK private providers are not available yet.';

    test('reports whether the organization has the feature', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.byok.privateProvidersEnabled({ organizationId: organization.id })
      ).resolves.toBe(true);

      await enableByokPrivateProviders([otherOrganization.id]);
      await expect(
        caller.byok.privateProvidersEnabled({ organizationId: organization.id })
      ).resolves.toBe(false);
      await expect(caller.byok.privateProvidersEnabled({})).resolves.toBe(false);
    });

    test('rejects creating, updating and importing models without the feature', async () => {
      const created = await createPrivateProvider();
      await enableByokPrivateProviders([otherOrganization.id]);
      const caller = await createCallerForUser(owner.id);

      await expect(createPrivateProvider()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: UNAVAILABLE,
      });
      await expect(
        caller.byok.updatePrivateProvider({
          organizationId: organization.id,
          id: created.id,
          definition: DEFINITION,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: UNAVAILABLE });
      await expect(
        caller.byok.listModelsFromPrivateProvider({
          organizationId: organization.id,
          base_url: DEFINITION.base_url,
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: UNAVAILABLE });
    });

    test('keeps existing private providers listed, switchable, testable and deletable without the feature', async () => {
      const created = await createPrivateProvider();
      await enableByokPrivateProviders([]);
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      const keys = await caller.byok.list({ organizationId: organization.id });
      expect(keys.map(key => key.id)).toContain(created.id);
      await expect(
        caller.byok.setEnabled({
          organizationId: organization.id,
          id: created.id,
          is_enabled: false,
        })
      ).resolves.toMatchObject({ is_enabled: false });
      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toMatchObject({ outcome: 'ok' });
      await expect(
        caller.byok.delete({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({ success: true });
    });
  });

  describe('createPrivateProvider', () => {
    test('stores the definition and the encrypted credentials, and lists the private provider by name', async () => {
      const created = await createPrivateProvider();

      expect(created.provider_id).toMatch(/^private-[a-z0-9]{10}$/);
      expect(created).toMatchObject({
        provider_name: 'Internal gateway',
        is_private_provider: true,
        private_provider: DEFINITION,
        supports_catalog_mode: true,
        serve_catalog_models: false,
      });
      const row = await storedRow(created.id);
      expect(row.settings.private_provider).toEqual(DEFINITION);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);

      const caller = await createCallerForUser(member.id);
      const [listed] = await caller.byok.list({ organizationId: organization.id });
      expect(listed).toMatchObject({
        id: created.id,
        provider_name: 'Internal gateway',
        is_private_provider: true,
        private_provider: null,
      });

      const ownerCaller = await createCallerForUser(owner.id);
      const [ownerListed] = await ownerCaller.byok.list({ organizationId: organization.id });
      expect(ownerListed).toMatchObject({ id: created.id, private_provider: DEFINITION });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id));
      expect(
        logs.some(
          log =>
            log.message ===
              `Added BYOK private provider Internal gateway (${created.provider_id})` &&
            log.actor_id === owner.id
        )
      ).toBe(true);
    });

    test('requires an organization', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.byok.createPrivateProvider({
          definition: DEFINITION,
          credentials: API_KEY_CREDENTIALS,
        } as unknown as Parameters<typeof caller.byok.createPrivateProvider>[0])
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('requires an owner or billing manager', async () => {
      const caller = await createCallerForUser(member.id);
      await expect(
        caller.byok.createPrivateProvider({
          organizationId: organization.id,
          definition: DEFINITION,
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('rejects a definition whose client API is not supported', async () => {
      await expect(
        createPrivateProvider({ ...DEFINITION, client_provider: 'anthropic' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test.each([
      ['http://llm.example.com/v1', 'The private provider URL must use HTTPS.'],
      ['https://127.0.0.1/v1', 'The private provider URL must point to a public host.'],
    ])('rejects %s where the URL policy applies', async (base_url, message) => {
      setNodeEnv('production');
      await expect(createPrivateProvider({ ...DEFINITION, base_url })).rejects.toThrow(message);
    });

    test('is not accepted through the provider key procedures', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.byok.create({
          organizationId: organization.id,
          provider_id: 'private-abcdefghij',
          api_key: 'secret',
        })
      ).rejects.toThrow('Private providers are added with createPrivateProvider.');

      const created = await createPrivateProvider();
      await expect(
        caller.byok.update({ organizationId: organization.id, id: created.id, api_key: 'raw' })
      ).rejects.toThrow('Private providers are updated with updatePrivateProvider.');
      expect(JSON.parse(decryptStoredKey(await storedRow(created.id)))).toEqual(
        API_KEY_CREDENTIALS
      );
    });
  });

  describe('updatePrivateProvider', () => {
    test('keeps the stored credentials when none are given', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, name: 'Renamed' };

      const updated = await caller.byok.updatePrivateProvider({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      expect(updated).toMatchObject({ provider_name: 'Renamed', private_provider: definition });
      const row = await storedRow(created.id);
      expect(row.settings.private_provider).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);
    });

    test('keeps catalog mode and the priority', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      await caller.byok.setCatalogMode({
        organizationId: organization.id,
        id: created.id,
        serve_catalog_models: true,
      });
      await caller.byok.reorder({ organizationId: organization.id, keyIds: [created.id] });
      const definition = { ...DEFINITION, name: 'Renamed' };

      const updated = await caller.byok.updatePrivateProvider({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      expect(updated).toMatchObject({ serve_catalog_models: true, private_provider: definition });
      expect((await storedRow(created.id)).settings).toEqual({
        serve_catalog_models: true,
        priority: 0,
        private_provider: definition,
      });
    });

    test('replaces the credentials when given', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      const credentials: ByokPrivateProviderCredentials = {
        type: 'x-api-key',
        api_key: 'new-secret',
      };

      await caller.byok.updatePrivateProvider({
        organizationId: organization.id,
        id: created.id,
        definition: DEFINITION,
        credentials,
      });

      expect(JSON.parse(decryptStoredKey(await storedRow(created.id)))).toEqual(credentials);
    });

    test('requires credentials when the host changes', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, base_url: 'https://attacker.example.com/v1' };

      await expect(
        caller.byok.updatePrivateProvider({
          organizationId: organization.id,
          id: created.id,
          definition,
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Enter the credentials again to use a different host',
      });
      expect((await storedRow(created.id)).settings.private_provider).toEqual(DEFINITION);

      const credentials: ByokPrivateProviderCredentials = {
        type: 'api_key',
        api_key: 'new-host-secret',
      };
      await caller.byok.updatePrivateProvider({
        organizationId: organization.id,
        id: created.id,
        definition,
        credentials,
      });
      const row = await storedRow(created.id);
      expect(row.settings.private_provider).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(credentials);
    });

    test('conflicts when the stored host changed after the host check', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      const changed = { ...DEFINITION, base_url: 'https://attacker.example.com/v1' };
      afterPrivateProviderUrlCheck = async () => {
        await db
          .update(byok_api_keys)
          .set({ settings: { private_provider: changed } })
          .where(eq(byok_api_keys.id, created.id));
      };

      await expect(
        caller.byok.updatePrivateProvider({
          organizationId: organization.id,
          id: created.id,
          definition: { ...DEFINITION, base_url: 'https://llm.example.com/v2' },
        })
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The private provider changed; reload and try again',
      });
      expect((await storedRow(created.id)).settings.private_provider).toEqual(changed);
    });

    test('keeps the stored credentials when only the path changes', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(owner.id);
      const definition = { ...DEFINITION, base_url: 'https://llm.example.com/v2' };

      await caller.byok.updatePrivateProvider({
        organizationId: organization.id,
        id: created.id,
        definition,
      });

      const row = await storedRow(created.id);
      expect(row.settings.private_provider).toEqual(definition);
      expect(JSON.parse(decryptStoredKey(row))).toEqual(API_KEY_CREDENTIALS);
    });

    test('only updates private providers of the organization', async () => {
      const created = await createPrivateProvider();
      const providerKey = await (
        await createCallerForUser(owner.id)
      ).byok.create({ organizationId: organization.id, provider_id: 'anthropic', api_key: 'k' });
      const otherCaller = await createCallerForUser(otherOwner.id);
      const ownerCaller = await createCallerForUser(owner.id);

      await expect(
        otherCaller.byok.updatePrivateProvider({
          organizationId: otherOrganization.id,
          id: created.id,
          definition: DEFINITION,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        ownerCaller.byok.updatePrivateProvider({
          organizationId: organization.id,
          id: providerKey.id,
          definition: DEFINITION,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('stored definitions', () => {
    test('lists a private provider whose definition no longer parses without it', async () => {
      const created = await createPrivateProvider();
      await db
        .update(byok_api_keys)
        .set({ settings: { priority: 3, private_provider: { name: 'Broken' } } as never })
        .where(eq(byok_api_keys.id, created.id));
      const caller = await createCallerForUser(owner.id);

      const [listed] = await caller.byok.list({ organizationId: organization.id });

      expect(listed).toMatchObject({
        id: created.id,
        is_private_provider: true,
        private_provider: null,
      });
      expect(listed.provider_name).not.toBe('Broken');
    });

    test('ignores a private provider definition in the settings of a provider key', async () => {
      const caller = await createCallerForUser(owner.id);
      const providerKey = await caller.byok.create({
        organizationId: organization.id,
        provider_id: 'anthropic',
        api_key: 'k',
      });
      await db
        .update(byok_api_keys)
        .set({ settings: { private_provider: DEFINITION } })
        .where(eq(byok_api_keys.id, providerKey.id));

      const [listed] = await caller.byok.list({ organizationId: organization.id });

      expect(listed).toMatchObject({
        id: providerKey.id,
        is_private_provider: false,
        private_provider: null,
      });
      expect(listed.provider_name).not.toBe(DEFINITION.name);
    });
  });

  test('listPrivateProviderCatalogModelIds is limited to roles that manage keys', async () => {
    const memberCaller = await createCallerForUser(member.id);
    await expect(
      memberCaller.byok.listPrivateProviderCatalogModelIds({
        organizationId: organization.id,
        modelIds: ['my-model'],
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const ownerCaller = await createCallerForUser(owner.id);
    await expect(
      ownerCaller.byok.listPrivateProviderCatalogModelIds({
        organizationId: organization.id,
        modelIds: [],
      })
    ).resolves.toEqual([]);
  });

  test('setCatalogMode turns catalog mode on for a private provider', async () => {
    const created = await createPrivateProvider();
    const caller = await createCallerForUser(owner.id);

    const updated = await caller.byok.setCatalogMode({
      organizationId: organization.id,
      id: created.id,
      serve_catalog_models: true,
    });

    expect(updated).toMatchObject({ serve_catalog_models: true, can_change_catalog_mode: true });
  });

  describe('listModelsFromPrivateProvider', () => {
    const MODELS_RESPONSE = {
      data: [{ id: 'Org/My-Model', name: 'My Model', context_length: 64000 }],
    };

    test('lists the models with the given credentials', async () => {
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      const result = await caller.byok.listModelsFromPrivateProvider({
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
      expect(headersOf(upstream.calls[0]).get('authorization')).toBe(
        'Bearer private-provider-secret'
      );
    });

    test('uses the stored credentials of a private provider', async () => {
      const created = await createPrivateProvider(DEFINITION, {
        type: 'x-api-key',
        api_key: 'stored',
      });
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.listModelsFromPrivateProvider({
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
      const created = await createPrivateProvider();
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.listModelsFromPrivateProvider({
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

    test('signs AWS requests with SigV4', async () => {
      const upstream = mockUpstream(() => Response.json(MODELS_RESPONSE));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.listModelsFromPrivateProvider({
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

    test('does not read another organization private provider credentials', async () => {
      const created = await createPrivateProvider();
      const caller = await createCallerForUser(otherOwner.id);

      await expect(
        caller.byok.listModelsFromPrivateProvider({
          organizationId: otherOrganization.id,
          base_url: 'https://llm.example.com/v1',
          id: created.id,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test.each([
      [
        'a rejected key',
        'https://llm.example.com/v1',
        () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }),
        'The private provider could not list its models: HTTP 401: Invalid API key',
      ],
      [
        'a rejected key the upstream echoes',
        'https://llm.example.com/v1',
        () =>
          Response.json(
            { error: { message: `Invalid key ${PRIVATE_PROVIDER_API_KEY}` } },
            { status: 401 }
          ),
        'The private provider could not list its models: HTTP 401: Invalid key [redacted]',
      ],
      [
        'a redirect',
        'https://llm.example.com/v1',
        () => new Response(null, { status: 307, headers: { location: 'http://10.0.0.1/' } }),
        'The private provider responded with a redirect',
      ],
    ])('reports %s', async (_case, base_url, respond, message) => {
      const upstream = mockUpstream(respond);
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.listModelsFromPrivateProvider({
          organizationId: organization.id,
          base_url,
          credentials: API_KEY_CREDENTIALS,
        })
      ).rejects.toThrow(message);
    });
  });

  describe('testApiKey', () => {
    test('sends a Chat Completions request to the first model', async () => {
      const created = await createPrivateProvider();
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({
        outcome: 'ok',
        provider: 'Internal gateway',
        model: 'my-model',
        success: true,
        message: 'API key test success. Provider: Internal gateway. Model: my-model.',
      });
      expect(upstream.calls[0].url).toBe('https://llm.example.com/v1/chat/completions');
      expect(headersOf(upstream.calls[0]).get('authorization')).toBe(
        'Bearer private-provider-secret'
      );
      const body = bodyOf(upstream.calls[0]);
      expect(body).toMatchObject({
        model: 'Org/My-Model',
        messages: [{ role: 'user', content: 'Say hi' }],
        max_tokens: 256,
      });
      // Transformed like a gateway request to the private provider.
      expect(body).not.toHaveProperty('user');
      expect(body).not.toHaveProperty('safety_identifier');
      expect(body).not.toHaveProperty('prompt_cache_key');
    });

    test('sends the prompt cache key when the private provider turns it on', async () => {
      const created = await createPrivateProvider({ ...DEFINITION, send_prompt_cache_key: true });
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await caller.byok.testApiKey({ organizationId: organization.id, id: created.id });

      expect(bodyOf(upstream.calls[0]).prompt_cache_key).toEqual(expect.any(String));
    });

    test('retries with max_completion_tokens when the upstream asks for it', async () => {
      const created = await createPrivateProvider();
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
      ).resolves.toMatchObject({ outcome: 'ok' });
      expect(bodyOf(upstream.calls[1])).toMatchObject({ max_completion_tokens: 256 });
      expect(bodyOf(upstream.calls[1])).not.toHaveProperty('max_tokens');
    });

    test('fails without sending anything when the stored credentials do not parse', async () => {
      const created = await createPrivateProvider();
      await db
        .update(byok_api_keys)
        .set({ encrypted_api_key_envelope: testByokEnvelope('not json') })
        .where(eq(byok_api_keys.id, created.id));
      const upstream = mockUpstream(() => Response.json({ choices: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({
        outcome: 'failed',
        detail: 'the stored private provider configuration is invalid.',
        success: false,
        message: 'API key test failed: the stored private provider configuration is invalid.',
      });
      expect(upstream.calls).toEqual([]);
    });

    test('sends a Messages request to a chosen model', async () => {
      const created = await createPrivateProvider({
        ...DEFINITION,
        base_url: 'https://llm.example.com/models',
        api_kinds: ['chat_completions', 'messages'],
        models: [
          ...DEFINITION.models,
          {
            id: 'claude',
            internal_id: 'claude/sonnet',
            context_length: 200000,
            max_completion_tokens: 64000,
            client_provider: 'anthropic',
          },
        ],
      });
      const upstream = mockUpstream(() => Response.json({ content: [] }));
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({
          organizationId: organization.id,
          id: created.id,
          modelId: 'claude',
        })
      ).resolves.toMatchObject({ outcome: 'ok' });
      expect(upstream.calls[0].url).toBe('https://llm.example.com/models/messages');
      expect(headersOf(upstream.calls[0]).get('anthropic-version')).toBe('2023-06-01');
      const body = bodyOf(upstream.calls[0]);
      expect(body).toMatchObject({ model: 'claude/sonnet', max_tokens: 256 });
    });

    test('redacts the credentials the upstream echoes', async () => {
      const created = await createPrivateProvider();
      const upstream = mockUpstream(() =>
        Response.json(
          { error: { message: `Bad key sk-...${PRIVATE_PROVIDER_API_KEY.slice(-4)}` } },
          { status: 401 }
        )
      );
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      const result = await caller.byok.testApiKey({
        organizationId: organization.id,
        id: created.id,
      });

      expect(result).toEqual({
        outcome: 'failed',
        detail: 'HTTP 401: Bad key sk-...[redacted]',
        success: false,
        message: 'API key test failed: HTTP 401: Bad key sk-...[redacted]',
      });
    });

    test('reports the upstream error', async () => {
      const created = await createPrivateProvider();
      const upstream = mockUpstream(() =>
        Response.json({ error: { message: 'model not found' } }, { status: 404 })
      );
      restoreFetch = upstream.restore;
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.byok.testApiKey({ organizationId: organization.id, id: created.id })
      ).resolves.toEqual({
        outcome: 'failed',
        detail: 'HTTP 404: model not found',
        success: false,
        message: 'API key test failed: HTTP 404: model not found',
      });
    });
  });

  test('deleting a private provider removes it', async () => {
    const created = await createPrivateProvider();
    const caller = await createCallerForUser(owner.id);

    await caller.byok.delete({ organizationId: organization.id, id: created.id });

    const rows = await db
      .select()
      .from(byok_api_keys)
      .where(and(eq(byok_api_keys.organization_id, organization.id)));
    expect(rows).toEqual([]);
  });
});
