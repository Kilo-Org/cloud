import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
// Catalog-mode code reads the catalog snapshot through a process-wide cache. Stubbing those reads
// keeps the cache unfilled for the listSupportedModels test, which inserts its own snapshot.
// `jest` stays global rather than imported from @jest/globals, so this mock is hoisted.
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => {
  const actual = jest.requireActual<typeof GatewayModelsCache>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  );
  return {
    ...actual,
    isValidOpenRouterModelId: jest.fn(async () => true),
    getOpenRouterModelsMetadataFromDatabase: jest.fn(
      actual.getOpenRouterModelsMetadataFromDatabase
    ),
    getVercelModelsMetadataFromDatabase: jest.fn(actual.getVercelModelsMetadataFromDatabase),
    getVercelModelsFromDatabase: jest.fn(actual.getVercelModelsFromDatabase),
  };
});

import { createCallerForUser } from '@/routers/test-utils';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getOpenRouterModelsMetadataFromDatabase,
  getVercelModelsFromDatabase,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  direct_byok_model_lists,
  modelsByProvider,
  organization_audit_logs,
} from '@kilocode/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { User, Organization } from '@kilocode/db/schema';
import { decryptApiKey, encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';

type Caller = Awaited<ReturnType<typeof createCallerForUser>>;

const VERTEX_CREDENTIALS = JSON.stringify({
  project: 'example-project',
  location: 'us-east5',
  googleCredentials: {
    privateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
    clientEmail: 'gateway@example-project.iam.gserviceaccount.com',
  },
});

const AZURE_CREDENTIALS = JSON.stringify({
  apiKey: 'azure-api-key',
  resourceName: 'example-resource',
});

const BEDROCK_IAM_CREDENTIALS = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'bedrock-test-secret',
  region: 'us-east-1',
};

const BEDROCK_API_KEY_CREDENTIALS = {
  apiKey: 'bedrock-test-api-key',
  region: 'us-west-2',
};

describe('BYOK Router', () => {
  let ownerUser: User;
  let memberUser: User;
  let otherOrgOwner: User;
  let organizationA: Organization;
  let organizationB: Organization;

  beforeAll(async () => {
    // Create test users
    ownerUser = await insertTestUser({
      google_user_email: 'byok-owner@example.com',
      google_user_name: 'BYOK Owner',
    });

    memberUser = await insertTestUser({
      google_user_email: 'byok-member@example.com',
      google_user_name: 'BYOK Member',
    });

    otherOrgOwner = await insertTestUser({
      google_user_email: 'byok-other-owner@example.com',
      google_user_name: 'Other Org Owner',
    });

    // Create test organizations
    organizationA = await createTestOrganization('BYOK Test Org A', ownerUser.id, 100000);
    organizationB = await createTestOrganization('BYOK Test Org B', otherOrgOwner.id, 100000);

    // Add member to organization A
    await addUserToOrganization(organizationA.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    await db
      .delete(coding_plan_subscriptions)
      .where(eq(coding_plan_subscriptions.user_id, ownerUser.id));
    await db
      .delete(coding_plan_key_inventory)
      .where(eq(coding_plan_key_inventory.assigned_to_user_id, ownerUser.id));
    // Clean up BYOK keys after each test
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organizationA.id));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organizationB.id));
    await db.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, ownerUser.id));
  });

  describe('list', () => {
    test('should return empty array when organization has no keys', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const result = await caller.byok.list({ organizationId: organizationA.id });

      expect(result).toEqual([]);
    });

    test('should return keys for organization', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      // Create a key
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-api-key-123',
      });

      // List keys
      const result = await caller.byok.list({ organizationId: organizationA.id });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(created.id);
      expect(result[0].provider_id).toBe('anthropic');
      expect(result[0].provider_name).toBe('anthropic');
      expect(result[0].created_by).toBe(ownerUser.id);
    });

    test('should allow members to list keys', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      // Owner creates a key
      await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'test-openai-key',
      });

      // Member can list keys
      const result = await memberCaller.byok.list({ organizationId: organizationA.id });

      expect(result).toHaveLength(1);
      expect(result[0].provider_id).toBe('openai');
    });

    test('should only return keys for specified organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create keys in both organizations
      await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'key-org-a',
      });

      await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'openai',
        api_key: 'key-org-b',
      });

      // List keys for org A
      const resultA = await callerA.byok.list({ organizationId: organizationA.id });
      expect(resultA).toHaveLength(1);
      expect(resultA[0].provider_id).toBe('anthropic');

      // List keys for org B
      const resultB = await callerB.byok.list({ organizationId: organizationB.id });
      expect(resultB).toHaveLength(1);
      expect(resultB[0].provider_id).toBe('openai');
    });

    test('should throw UNAUTHORIZED when user is not a member', async () => {
      const caller = await createCallerForUser(otherOrgOwner.id);

      await expect(caller.byok.list({ organizationId: organizationA.id })).rejects.toThrow(
        'You do not have access to this organization'
      );
    });
  });

  describe('reorder', () => {
    async function createPersonalKeys(
      userId: string,
      providers: Parameters<Caller['byok']['create']>[0]['provider_id'][]
    ) {
      const caller = await createCallerForUser(userId);
      const ids: string[] = [];
      for (const provider_id of providers) {
        const key = await caller.byok.create({ provider_id, api_key: `key-${provider_id}` });
        ids.push(key.id);
      }
      return { caller, ids };
    }

    test('lists personal keys oldest first until the owner reorders them', async () => {
      const { caller, ids } = await createPersonalKeys(ownerUser.id, [
        'anthropic',
        'mistral',
        'openrouter',
      ]);
      expect((await caller.byok.list({})).map(key => key.id)).toEqual(ids);

      const reordered = [ids[2], ids[0], ids[1]];
      const result = await caller.byok.reorder({ keyIds: reordered });

      expect(result.map(key => key.id)).toEqual(reordered);
      expect((await caller.byok.list({})).map(key => key.id)).toEqual(reordered);
      const rows = await db
        .select({ id: byok_api_keys.id, settings: byok_api_keys.settings })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.kilo_user_id, ownerUser.id));
      expect(Object.fromEntries(rows.map(row => [row.id, row.settings]))).toEqual({
        [ids[2]]: { priority: 0 },
        [ids[0]]: { priority: 1 },
        [ids[1]]: { priority: 2 },
      });
    });

    test('keeps other settings and lists keys added later after the prioritized ones', async () => {
      const { caller, ids } = await createPersonalKeys(ownerUser.id, ['anthropic', 'mistral']);
      await db
        .update(byok_api_keys)
        .set({ settings: { serve_catalog_models: true } })
        .where(eq(byok_api_keys.id, ids[0]));

      await caller.byok.reorder({ keyIds: [ids[1], ids[0]] });
      const added = await caller.byok.create({ provider_id: 'openai', api_key: 'key-openai' });

      expect((await caller.byok.list({})).map(key => key.id)).toEqual([ids[1], ids[0], added.id]);
      const [catalogKey] = await db
        .select({ settings: byok_api_keys.settings })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, ids[0]));
      expect(catalogKey?.settings).toEqual({ serve_catalog_models: true, priority: 1 });
    });

    test('rejects an order that leaves out one of the caller keys', async () => {
      const { caller, ids } = await createPersonalKeys(ownerUser.id, ['anthropic', 'mistral']);

      await expect(caller.byok.reorder({ keyIds: [ids[1]] })).rejects.toThrow(
        'Your API keys changed'
      );
      expect((await caller.byok.list({})).map(key => key.id)).toEqual(ids);
    });

    test('rejects another user key without changing it', async () => {
      const { ids: ownerIds } = await createPersonalKeys(ownerUser.id, ['anthropic']);
      const { caller: memberCaller, ids: memberIds } = await createPersonalKeys(memberUser.id, [
        'mistral',
      ]);
      try {
        await expect(
          memberCaller.byok.reorder({ keyIds: [ownerIds[0], memberIds[0]] })
        ).rejects.toThrow('Your API keys changed');
        await expect(memberCaller.byok.reorder({ keyIds: [ownerIds[0]] })).rejects.toThrow(
          'Your API keys changed'
        );
        const [ownerKey] = await db
          .select({ settings: byok_api_keys.settings })
          .from(byok_api_keys)
          .where(eq(byok_api_keys.id, ownerIds[0]));
        expect(ownerKey?.settings).toEqual({});
      } finally {
        await db.delete(byok_api_keys).where(eq(byok_api_keys.kilo_user_id, memberUser.id));
      }
    });

    test('rejects organization keys, which keep their default order', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const orgKey = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'org-key',
      });

      await expect(caller.byok.reorder({ keyIds: [orgKey.id] })).rejects.toThrow(
        'Your API keys changed'
      );
    });

    test('ignores the ChatGPT connection row, which is not a listed key', async () => {
      const { caller, ids } = await createPersonalKeys(ownerUser.id, ['anthropic', 'mistral']);
      await db.insert(byok_api_keys).values({
        kilo_user_id: ownerUser.id,
        provider_id: 'openai-chatgpt',
        encrypted_api_key: encryptApiKey('chatgpt-state', BYOK_ENCRYPTION_KEY),
        created_by: ownerUser.id,
      });

      await caller.byok.reorder({ keyIds: [ids[1], ids[0]] });

      const [chatGpt] = await db
        .select({ settings: byok_api_keys.settings })
        .from(byok_api_keys)
        .where(
          and(
            eq(byok_api_keys.kilo_user_id, ownerUser.id),
            eq(byok_api_keys.provider_id, 'openai-chatgpt')
          )
        );
      expect(chatGpt?.settings).toEqual({});
    });

    test('rejects duplicate ids', async () => {
      const { caller, ids } = await createPersonalKeys(ownerUser.id, ['anthropic']);

      await expect(caller.byok.reorder({ keyIds: [ids[0], ids[0]] })).rejects.toThrow(
        'Key ids must be unique'
      );
    });
  });

  describe('create', () => {
    test('should create a new BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-test-key-123',
      });

      expect(result.id).toBeDefined();
      expect(result.provider_id).toBe('anthropic');
      expect(result.provider_name).toBe('anthropic');
      expect(result.created_by).toBe(ownerUser.id);
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();

      // Verify key is encrypted in database
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, result.id));

      expect(dbKey).toBeDefined();
      expect(dbKey.encrypted_api_key).toBeDefined();
      expect(typeof dbKey.encrypted_api_key).toBe('object');
      expect(dbKey.encrypted_api_key).toHaveProperty('iv');
      expect(dbKey.encrypted_api_key).toHaveProperty('data');
      expect(dbKey.encrypted_api_key).toHaveProperty('authTag');
    });

    test('should create a Vertex BYOK credential', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'vertex',
        api_key: VERTEX_CREDENTIALS,
      });

      expect(result.provider_id).toBe('vertex');
    });

    test('should create an Azure BYOK credential', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const result = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'azure',
        api_key: AZURE_CREDENTIALS,
      });

      expect(result.provider_id).toBe('azure');
    });

    test('should reject malformed Azure credentials', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'azure',
          api_key: '{"apiKey":"secret"}',
        })
      ).rejects.toThrow('Invalid credentials for provider: azure');
    });

    test('should reject malformed Vertex credentials', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'vertex',
          api_key: '{"privateKey":"secret"}',
        })
      ).rejects.toThrow('Invalid credentials for provider: vertex');
    });

    test('should create audit log entry', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'sk-test-key',
      });

      // Check audit log
      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const relevantLog = logs.find(log =>
        log.message.includes('Added BYOK key for provider: openai')
      );
      expect(relevantLog).toBeDefined();
      expect(relevantLog?.actor_id).toBe(ownerUser.id);
      expect(relevantLog?.actor_email).toBe(ownerUser.google_user_email);
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'anthropic',
          api_key: 'test-key',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should throw UNAUTHORIZED when user is not a member of organization', async () => {
      const caller = await createCallerForUser(otherOrgOwner.id);

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'anthropic',
          api_key: 'test-key',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    test('should allow multiple keys for different providers', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const key1 = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'anthropic-key',
      });

      const key2 = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'openai-key',
      });

      expect(key1.provider_id).toBe('anthropic');
      expect(key2.provider_id).toBe('openai');

      const keys = await caller.byok.list({ organizationId: organizationA.id });
      expect(keys).toHaveLength(2);
    });
  });

  describe('KMS envelope encryption', () => {
    const originalFetch = global.fetch;
    const originalUrl = process.env.BYOK_KMS_SERVICE_URL;
    const originalToken = process.env.BYOK_KMS_SERVICE_TOKEN;

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.BYOK_KMS_SERVICE_URL;
      else process.env.BYOK_KMS_SERVICE_URL = originalUrl;
      if (originalToken === undefined) delete process.env.BYOK_KMS_SERVICE_TOKEN;
      else process.env.BYOK_KMS_SERVICE_TOKEN = originalToken;
    });

    function configureKms(response: () => Response) {
      process.env.BYOK_KMS_SERVICE_URL = 'http://kms.test';
      process.env.BYOK_KMS_SERVICE_TOKEN = 'token';
      const fetchMock = jest.fn(async () => response());
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    const issuedDataKeys: string[] = [];
    const dataKeyResponse = () => {
      const data_key = randomBytes(32).toString('base64');
      issuedDataKeys.push(data_key);
      return Response.json({
        data_key,
        wrapped_dek: 'wrapped',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    };

    beforeEach(() => {
      issuedDataKeys.length = 0;
    });

    test('leaves the envelope NULL when the service is not configured', async () => {
      delete process.env.BYOK_KMS_SERVICE_URL;
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-no-kms',
      });

      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, created.id));
      expect(dbKey.encrypted_api_key_envelope).toBeNull();
    });

    test('writes both columns on create and update when the service is configured', async () => {
      const fetchMock = configureKms(dataKeyResponse);
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-kms',
      });

      const [createdKey] = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, created.id));
      expect(createdKey.encrypted_api_key_envelope).toMatchObject({
        wrapped_dek: 'wrapped',
        kms_key_id: 'alias/test',
      });
      expect(decryptApiKey(createdKey.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-ant-kms');
      expect(
        decryptApiKey(createdKey.encrypted_api_key_envelope!.encrypted_data, issuedDataKeys[0])
      ).toBe('sk-ant-kms');

      await caller.byok.update({
        organizationId: organizationA.id,
        id: created.id,
        api_key: 'sk-ant-kms-2',
      });

      const [updatedKey] = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, created.id));
      expect(decryptApiKey(updatedKey.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-ant-kms-2');
      expect(
        decryptApiKey(updatedKey.encrypted_api_key_envelope!.encrypted_data, issuedDataKeys[1])
      ).toBe('sk-ant-kms-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const sent = fetchMock.mock.calls.map(call => {
        const [, init] = call as unknown as [string, RequestInit];
        return JSON.parse(String(init.body));
      });
      for (const body of sent) {
        expect(body).toEqual({
          key_id: created.id,
          actor_user_id: ownerUser.id,
          owner_type: 'organization',
          owner_id: organizationA.id,
          provider_id: 'anthropic',
        });
      }
    });

    test('testApiKey reports a failure instead of throwing when the KMS call fails', async () => {
      configureKms(dataKeyResponse);
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-kms',
      });
      configureKms(() => new Response('{}', { status: 503 }));

      await expect(
        caller.byok.testApiKey({ organizationId: organizationA.id, id: created.id })
      ).resolves.toEqual({
        success: false,
        message: 'API key test failed: the stored key could not be read. Try again later.',
      });
    });

    test('fails create and update without writing when the KMS call fails', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'sk-ant-before',
      });
      configureKms(() => new Response('{}', { status: 503 }));

      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'openai',
          api_key: 'sk-openai-kms-fail',
        })
      ).rejects.toThrow();
      await expect(
        caller.byok.update({
          organizationId: organizationA.id,
          id: created.id,
          api_key: 'sk-ant-after',
        })
      ).rejects.toThrow();

      const keys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.organization_id, organizationA.id));
      expect(keys.map(key => key.provider_id)).toEqual(['anthropic']);
      expect(decryptApiKey(keys[0].encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('sk-ant-before');
    });
  });

  describe('update', () => {
    test('should update an existing BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      // Create a key
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'old-key',
      });

      // Update the key
      const updated = await caller.byok.update({
        organizationId: organizationA.id,
        id: created.id,
        api_key: 'new-key',
      });

      expect(updated.id).toBe(created.id);
      expect(updated.provider_id).toBe('anthropic');
      expect(updated.updated_at).not.toBe(created.updated_at);

      // Verify encryption changed
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, created.id));

      expect(dbKey.encrypted_api_key).toBeDefined();
      expect(typeof dbKey.encrypted_api_key).toBe('object');
      expect(dbKey.encrypted_api_key).toHaveProperty('iv');
      expect(dbKey.encrypted_api_key).toHaveProperty('data');
    });

    test('should reject malformed Vertex credentials on update', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'vertex',
        api_key: VERTEX_CREDENTIALS,
      });

      await expect(
        caller.byok.update({
          organizationId: organizationA.id,
          id: created.id,
          api_key: '{}',
        })
      ).rejects.toThrow('Invalid credentials for provider: vertex');
    });

    test('should create audit log entry for update', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'original-key',
      });

      await caller.byok.update({
        organizationId: organizationA.id,
        id: created.id,
        api_key: 'updated-key',
      });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const updateLog = logs.find(log =>
        log.message.includes('Updated BYOK key for provider: openai')
      );
      expect(updateLog).toBeDefined();
    });

    test('should throw NOT_FOUND when key does not exist', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await expect(
        caller.byok.update({
          organizationId: organizationA.id,
          id: nonExistentId,
          api_key: 'new-key',
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      const created = await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      await expect(
        memberCaller.byok.update({
          organizationId: organizationA.id,
          id: created.id,
          api_key: 'new-key',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should prevent updating key from different organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org A
      const keyA = await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'org-a-key',
      });

      // Try to update org A's key from org B (should fail authorization check)
      await expect(
        callerB.byok.update({
          organizationId: organizationB.id,
          id: keyA.id,
          api_key: 'malicious-key',
        })
      ).rejects.toThrow('BYOK key not found');

      // Verify key was not updated
      const [dbKey] = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, keyA.id));

      expect(dbKey.organization_id).toBe(organizationA.id);
    });
  });

  describe('delete', () => {
    test('should delete a BYOK key', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      const result = await caller.byok.delete({
        organizationId: organizationA.id,
        id: created.id,
      });

      expect(result.success).toBe(true);

      // Verify key is deleted
      const keys = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, created.id));

      expect(keys).toHaveLength(0);
    });

    test('should create audit log entry for deletion', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const created = await caller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'openai',
        api_key: 'test-key',
      });

      await caller.byok.delete({
        organizationId: organizationA.id,
        id: created.id,
      });

      const logs = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, organizationA.id),
            eq(organization_audit_logs.action, 'organization.settings.change')
          )
        );

      const deleteLog = logs.find(log =>
        log.message.includes('Deleted BYOK key for provider: openai')
      );
      expect(deleteLog).toBeDefined();
    });

    test('should throw NOT_FOUND when key does not exist', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await expect(
        caller.byok.delete({
          organizationId: organizationA.id,
          id: nonExistentId,
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should throw UNAUTHORIZED when user is not an owner', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);

      const created = await ownerCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'test-key',
      });

      await expect(
        memberCaller.byok.delete({
          organizationId: organizationA.id,
          id: created.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    test('should prevent deleting key from different organization', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org A
      const keyA = await callerA.byok.create({
        organizationId: organizationA.id,
        provider_id: 'anthropic',
        api_key: 'org-a-key',
      });

      // Try to delete org A's key from org B (should fail)
      await expect(
        callerB.byok.delete({
          organizationId: organizationB.id,
          id: keyA.id,
        })
      ).rejects.toThrow('BYOK key not found');

      // Verify key still exists
      const keys = await db.select().from(byok_api_keys).where(eq(byok_api_keys.id, keyA.id));

      expect(keys).toHaveLength(1);
    });
  });

  describe('Bedrock credentials', () => {
    test.each(['user', 'organization'] as const)(
      'encrypts a %s API key credential and returns only metadata from create and list',
      async owner => {
        const caller = await createCallerForUser(ownerUser.id);
        const scope = owner === 'organization' ? { organizationId: organizationA.id } : {};
        const credential = JSON.stringify(BEDROCK_API_KEY_CREDENTIALS);

        const created = await caller.byok.create({
          ...scope,
          provider_id: 'bedrock',
          api_key: credential,
        });

        expect(created).toEqual({
          id: expect.any(String),
          provider_id: 'bedrock',
          provider_name: 'bedrock',
          management_source: 'user',
          is_enabled: true,
          serve_catalog_models: false,
          supports_catalog_mode: false,
          can_change_catalog_mode: false,
          created_by: ownerUser.id,
          created_at: expect.any(String),
          updated_at: expect.any(String),
        });
        await expect(caller.byok.list(scope)).resolves.toEqual([created]);

        const [stored] = await db
          .select()
          .from(byok_api_keys)
          .where(eq(byok_api_keys.id, created.id));
        expect(stored.organization_id).toBe(owner === 'organization' ? organizationA.id : null);
        expect(stored.kilo_user_id).toBe(owner === 'user' ? ownerUser.id : null);
        expect(stored.encrypted_api_key).toEqual({
          iv: expect.any(String),
          data: expect.any(String),
          authTag: expect.any(String),
        });
        expect(JSON.stringify(stored.encrypted_api_key)).not.toContain(
          BEDROCK_API_KEY_CREDENTIALS.apiKey
        );
        expect(decryptApiKey(stored.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe(credential);
      }
    );

    test.each([
      {
        owner: 'user',
        from: 'IAM',
        to: 'API key',
        initial: BEDROCK_IAM_CREDENTIALS,
        replacement: BEDROCK_API_KEY_CREDENTIALS,
      },
      {
        owner: 'organization',
        from: 'API key',
        to: 'IAM',
        initial: BEDROCK_API_KEY_CREDENTIALS,
        replacement: BEDROCK_IAM_CREDENTIALS,
      },
    ])(
      'replaces a $owner credential from $from to $to',
      async ({ owner, initial, replacement }) => {
        const caller = await createCallerForUser(ownerUser.id);
        const scope = owner === 'organization' ? { organizationId: organizationA.id } : {};
        const created = await caller.byok.create({
          ...scope,
          provider_id: 'bedrock',
          api_key: JSON.stringify(initial),
        });
        const [before] = await db
          .select()
          .from(byok_api_keys)
          .where(eq(byok_api_keys.id, created.id));
        expect(decryptApiKey(before.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe(
          JSON.stringify(initial)
        );

        const updated = await caller.byok.update({
          ...scope,
          id: created.id,
          api_key: JSON.stringify(replacement),
        });

        expect(updated).toEqual({ ...created, updated_at: expect.any(String) });
        await expect(caller.byok.list(scope)).resolves.toEqual([updated]);
        const [after] = await db
          .select()
          .from(byok_api_keys)
          .where(eq(byok_api_keys.id, created.id));
        expect(after.organization_id).toBe(before.organization_id);
        expect(after.kilo_user_id).toBe(before.kilo_user_id);
        expect(after.encrypted_api_key).not.toEqual(before.encrypted_api_key);
        expect(decryptApiKey(after.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe(
          JSON.stringify(replacement)
        );
      }
    );

    test.each([
      { name: 'missing API key', credentials: { region: 'us-east-1' } },
      { name: 'empty API key', credentials: { apiKey: '', region: 'us-east-1' } },
      { name: 'missing region', credentials: { apiKey: 'bedrock-test-api-key' } },
      { name: 'empty region', credentials: { apiKey: 'bedrock-test-api-key', region: '' } },
      {
        name: 'mixed IAM and API key',
        credentials: { ...BEDROCK_IAM_CREDENTIALS, apiKey: 'bedrock-test-api-key' },
      },
    ])('rejects $name credentials before create or update writes', async ({ credentials }) => {
      const caller = await createCallerForUser(ownerUser.id);
      const scope = { organizationId: organizationA.id };
      const created = await caller.byok.create({
        ...scope,
        provider_id: 'bedrock',
        api_key: JSON.stringify(BEDROCK_IAM_CREDENTIALS),
      });
      const keysBefore = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.organization_id, organizationA.id));
      const logsBefore = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationA.id))
        .orderBy(organization_audit_logs.id);
      const api_key = JSON.stringify(credentials);

      await expect(
        caller.byok.create({ ...scope, provider_id: 'bedrock', api_key })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Invalid credentials for provider: bedrock',
      });
      const keysAfterCreate = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.organization_id, organizationA.id));
      expect(keysAfterCreate).toEqual(keysBefore);

      await expect(caller.byok.update({ ...scope, id: created.id, api_key })).rejects.toMatchObject(
        {
          code: 'BAD_REQUEST',
          message: 'Invalid credentials for provider: bedrock',
        }
      );
      const keysAfterUpdate = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.organization_id, organizationA.id));
      expect(keysAfterUpdate).toEqual(keysBefore);
      const logsAfter = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationA.id))
        .orderBy(organization_audit_logs.id);
      expect(logsAfter).toEqual(logsBefore);
    });
  });

  describe('catalog mode', () => {
    let billingManagerUser: User;

    beforeAll(async () => {
      billingManagerUser = await insertTestUser({
        google_user_email: 'byok-billing-manager@example.com',
        google_user_name: 'BYOK Billing Manager',
      });
      await addUserToOrganization(organizationA.id, billingManagerUser.id, 'billing_manager');
      // Provider model lists are cached per process, so these rows must exist before the first
      // lookup of each provider, which no earlier test performs.
      const synced_at = new Date().toISOString();
      await db
        .insert(direct_byok_model_lists)
        .values([
          {
            provider_id: 'zai-coding',
            models: [
              {
                id: 'glm-5.2',
                name: 'GLM-5.2',
                context_length: 200000,
                max_completion_tokens: 32000,
                catalog_model_id: 'z-ai/glm-5.2',
              },
              {
                id: 'glm-4.7',
                name: 'GLM-4.7',
                context_length: 200000,
                max_completion_tokens: 32000,
                catalog_model_id: 'z-ai/glm-4.7',
              },
            ],
            synced_at,
          },
          {
            provider_id: 'morph-byok',
            models: [
              {
                id: 'morph-v3-fast',
                name: 'Morph v3 Fast',
                context_length: 200000,
                max_completion_tokens: 32000,
              },
            ],
            synced_at,
          },
        ])
        .onConflictDoUpdate({
          target: direct_byok_model_lists.provider_id,
          set: { models: sql`excluded.models` },
        });
    });

    afterAll(async () => {
      await db
        .delete(direct_byok_model_lists)
        .where(inArray(direct_byok_model_lists.provider_id, ['zai-coding', 'morph-byok']));
    });

    test('starts new keys outside catalog mode and offers it only with mapped models', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      const zai = await caller.byok.create({ provider_id: 'zai-coding', api_key: 'zai-key' });
      const morph = await caller.byok.create({ provider_id: 'morph-byok', api_key: 'morph-key' });
      const martian = await caller.byok.create({ provider_id: 'martian', api_key: 'martian-key' });
      const vercel = await caller.byok.create({ provider_id: 'openai', api_key: 'sk-test-key' });

      expect(zai).toMatchObject({
        serve_catalog_models: false,
        supports_catalog_mode: true,
        can_change_catalog_mode: true,
      });
      for (const key of [morph, martian, vercel]) {
        expect(key).toMatchObject({
          serve_catalog_models: false,
          supports_catalog_mode: false,
          can_change_catalog_mode: false,
        });
      }
      await expect(
        caller.byok.setCatalogMode({ id: morph.id, serve_catalog_models: true })
      ).rejects.toThrow('Provider morph-byok does not support Kilo catalog model IDs.');
      await expect(
        caller.byok.setCatalogMode({ id: vercel.id, serve_catalog_models: true })
      ).rejects.toThrow('Provider openai does not support Kilo catalog model IDs.');
    });

    test('lists the catalog ids each provider serves in catalog mode, sorted', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValueOnce({});

      const result = await caller.byok.listCatalogModeSupportedModels();

      expect(result['zai-coding']).toEqual(['GLM-4.7 (z-ai/glm-4.7)', 'GLM-5.2 (z-ai/glm-5.2)']);
      expect(result).not.toHaveProperty('morph-byok');
      expect(result).not.toHaveProperty('martian');
    });

    test('stores catalog mode in the key settings', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({ provider_id: 'zai-coding', api_key: 'zai-key' });
      await db
        .update(byok_api_keys)
        .set({ settings: sql`'{"future_setting": 1}'::jsonb` })
        .where(eq(byok_api_keys.id, created.id));

      const enabled = await caller.byok.setCatalogMode({
        id: created.id,
        serve_catalog_models: true,
      });

      expect(enabled.serve_catalog_models).toBe(true);
      const [stored] = await db
        .select({ settings: byok_api_keys.settings })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, created.id));
      expect(stored.settings).toEqual({ future_setting: 1, serve_catalog_models: true });
      await expect(caller.byok.list({})).resolves.toEqual([
        expect.objectContaining({ id: created.id, serve_catalog_models: true }),
      ]);
    });

    test('keeps an enabled key changeable after its provider loses catalog mappings', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({ provider_id: 'morph-byok', api_key: 'morph-key' });
      await db
        .update(byok_api_keys)
        .set({ settings: { serve_catalog_models: true } })
        .where(eq(byok_api_keys.id, created.id));

      await expect(caller.byok.list({})).resolves.toEqual([
        expect.objectContaining({
          serve_catalog_models: true,
          supports_catalog_mode: false,
          can_change_catalog_mode: true,
        }),
      ]);
      const disabled = await caller.byok.setCatalogMode({
        id: created.id,
        serve_catalog_models: false,
      });
      expect(disabled.serve_catalog_models).toBe(false);
    });

    test('lets organization billing managers create keys but not change catalog mode', async () => {
      const billingCaller = await createCallerForUser(billingManagerUser.id);
      const created = await billingCaller.byok.create({
        organizationId: organizationA.id,
        provider_id: 'zai-coding',
        api_key: 'zai-key',
      });

      expect(created).toMatchObject({
        serve_catalog_models: false,
        can_change_catalog_mode: false,
      });
      await expect(
        billingCaller.byok.setCatalogMode({
          organizationId: organizationA.id,
          id: created.id,
          serve_catalog_models: true,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      const ownerCaller = await createCallerForUser(ownerUser.id);
      await expect(ownerCaller.byok.list({ organizationId: organizationA.id })).resolves.toEqual([
        expect.objectContaining({ id: created.id, can_change_catalog_mode: true }),
      ]);
      const updated = await ownerCaller.byok.setCatalogMode({
        organizationId: organizationA.id,
        id: created.id,
        serve_catalog_models: true,
      });
      expect(updated.serve_catalog_models).toBe(true);

      const logs = await db
        .select({ message: organization_audit_logs.message })
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationA.id));
      expect(logs.map(log => log.message)).toContain(
        'Enabled Kilo catalog model IDs for BYOK key for provider: zai-coding'
      );
    });

    describe('previewRouting', () => {
      // Routing reads the Vercel catalog through process-wide caches, which must stay unfilled for
      // the listSupportedModels test.
      beforeEach(() => {
        jest.mocked(getVercelModelsMetadataFromDatabase).mockResolvedValue({});
        jest.mocked(getVercelModelsFromDatabase).mockResolvedValue(new Set());
      });

      afterEach(() => {
        const actual = jest.requireActual<typeof GatewayModelsCache>(
          '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
        );
        jest
          .mocked(getVercelModelsMetadataFromDatabase)
          .mockImplementation(actual.getVercelModelsMetadataFromDatabase);
        jest
          .mocked(getVercelModelsFromDatabase)
          .mockImplementation(actual.getVercelModelsFromDatabase);
      });

      async function createCatalogKey(
        caller: Awaited<ReturnType<typeof createCallerForUser>>,
        organizationId?: string
      ) {
        const created = await caller.byok.create({
          ...(organizationId && { organizationId }),
          provider_id: 'zai-coding',
          api_key: 'zai-key',
        });
        await caller.byok.setCatalogMode({
          ...(organizationId && { organizationId }),
          id: created.id,
          serve_catalog_models: true,
        });
        // A preview that decrypted this key would fail.
        await db
          .update(byok_api_keys)
          .set({
            encrypted_api_key: { iv: 'unreadable', data: 'unreadable', authTag: 'unreadable' },
            encrypted_api_key_envelope: null,
          })
          .where(eq(byok_api_keys.id, created.id));
        return created;
      }

      test('uses a catalog-mode key that serves the API kind, without decrypting it', async () => {
        const caller = await createCallerForUser(ownerUser.id);
        await createCatalogKey(caller);

        const preview = await caller.byok.previewRouting({ modelId: 'Z-AI/GLM-5.2' });

        expect(preview.kind).toBe('routes');
        if (preview.kind !== 'routes') return;
        expect(preview.steps[0]).toEqual({
          route: 'direct-byok',
          providerId: 'zai-coding',
          outcome: 'used',
          reason: 'serves',
          supportedApiKinds: ['chat_completions'],
        });
        expect(preview.steps.at(-1)).toMatchObject({ route: 'kilo', outcome: 'unreached' });
      });

      test('fails a request the catalog-mode keys cannot serve over the API kind', async () => {
        const caller = await createCallerForUser(ownerUser.id);
        await createCatalogKey(caller);

        const preview = await caller.byok.previewRouting({
          modelId: 'z-ai/glm-5.2',
          apiKind: 'responses',
        });

        if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
        expect(preview.steps).toEqual([
          expect.objectContaining({
            route: 'direct-byok',
            outcome: 'skipped',
            reason: 'unsupported-api-kind',
          }),
          expect.objectContaining({ route: 'unsupported-api-kind', outcome: 'used' }),
          expect.objectContaining({ route: 'kilo', outcome: 'unreached' }),
        ]);
      });

      test('skips disabled keys and keys outside catalog mode', async () => {
        const caller = await createCallerForUser(ownerUser.id);
        const created = await createCatalogKey(caller);

        await caller.byok.setEnabled({ id: created.id, is_enabled: false });
        const disabled = await caller.byok.previewRouting({ modelId: 'z-ai/glm-5.2' });
        await caller.byok.setEnabled({ id: created.id, is_enabled: true });
        await caller.byok.setCatalogMode({ id: created.id, serve_catalog_models: false });
        const providerIds = await caller.byok.previewRouting({ modelId: 'z-ai/glm-5.2' });

        for (const [preview, reason] of [
          [disabled, 'disabled'],
          [providerIds, 'not-catalog-mode'],
        ] as const) {
          if (preview.kind !== 'routes') throw new Error(`unexpected ${preview.kind} preview`);
          expect(preview.steps[0]).toMatchObject({
            route: 'direct-byok',
            outcome: 'skipped',
            reason,
          });
          expect(preview.steps.at(-1)).toMatchObject({ route: 'kilo', outcome: 'used' });
        }
      });

      test('reports provider model IDs as outside the catalog', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        await expect(
          caller.byok.previewRouting({ modelId: 'zai-coding/glm-5.2' })
        ).resolves.toEqual({ kind: 'not-catalog-model' });
      });

      test('previews organization keys for members only', async () => {
        await createCatalogKey(await createCallerForUser(ownerUser.id), organizationA.id);

        const memberCaller = await createCallerForUser(memberUser.id);
        const preview = await memberCaller.byok.previewRouting({
          organizationId: organizationA.id,
          modelId: 'z-ai/glm-5.2',
        });
        expect(preview.kind === 'routes' && preview.steps[0]).toMatchObject({
          route: 'direct-byok',
          outcome: 'used',
        });

        const outsiderCaller = await createCallerForUser(otherOrgOwner.id);
        await expect(
          outsiderCaller.byok.previewRouting({
            organizationId: organizationA.id,
            modelId: 'z-ai/glm-5.2',
          })
        ).rejects.toThrow('You do not have access to this organization');
      });
    });

    test('rejects catalog mode changes for keys of others', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const zai = await caller.byok.create({ provider_id: 'zai-coding', api_key: 'zai-key' });

      const otherCaller = await createCallerForUser(otherOrgOwner.id);
      await expect(
        otherCaller.byok.setCatalogMode({ id: zai.id, serve_catalog_models: true })
      ).rejects.toThrow('BYOK key not found');
    });
  });

  describe('gateway keys', () => {
    function chatCompletionResponse() {
      return new Response(
        JSON.stringify({
          id: 'gen-1',
          object: 'chat.completion',
          created: 0,
          model: 'openai/gpt-5-nano',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    test.each([
      { owner: 'user', providerId: 'openrouter' },
      { owner: 'organization', providerId: 'vercel-ai-gateway' },
    ] as const)('stores a $owner $providerId key', async ({ owner, providerId }) => {
      const caller = await createCallerForUser(ownerUser.id);
      const scope = owner === 'organization' ? { organizationId: organizationA.id } : {};

      const created = await caller.byok.create({
        ...scope,
        provider_id: providerId,
        api_key: 'gateway-secret',
      });

      expect(created).toMatchObject({ provider_id: providerId, is_enabled: true });
      const [stored] = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, created.id));
      expect(decryptApiKey(stored.encrypted_api_key, BYOK_ENCRYPTION_KEY)).toBe('gateway-secret');
    });

    test('tests an OpenRouter key against OpenRouter with the stored key', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const key = await caller.byok.create({
        provider_id: 'openrouter',
        api_key: 'user-openrouter-key',
      });
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(chatCompletionResponse());

      try {
        await expect(caller.byok.testApiKey({ id: key.id })).resolves.toMatchObject({
          success: true,
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-openrouter-key');
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'openai/gpt-5-nano' });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    test('reports a rejected Vercel AI Gateway key without SDK setup instructions', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const key = await caller.byok.create({
        provider_id: 'vercel-ai-gateway',
        api_key: 'revoked-vercel-key',
      });
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'Invalid API key', type: 'authentication_error' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      );

      try {
        await expect(caller.byok.testApiKey({ id: key.id })).resolves.toEqual({
          success: false,
          message:
            'API key test failed: Vercel AI Gateway rejected this API key. Check that the key is correct and has not been revoked.',
        });
        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toMatch(/^https:\/\/ai-gateway\.vercel\.sh\//);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer revoked-vercel-key');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('listSupportedModels', () => {
    test('lists models as "name (id)" per provider', async () => {
      const [snapshot] = await db
        .insert(modelsByProvider)
        .values({
          data: { providers: [], total_providers: 0, total_models: 0, generated_at: '' },
          openrouter: {
            'anthropic/claude-fixture': {
              id: 'anthropic/claude-fixture',
              name: 'Claude Fixture',
              endpoints: [],
            },
          },
          vercel: {
            'anthropic/claude-fixture': {
              id: 'anthropic/claude-fixture',
              name: 'Claude Fixture',
              type: 'language',
              endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
            },
          },
        })
        .returning({ id: modelsByProvider.id });

      try {
        const caller = await createCallerForUser(ownerUser.id);
        const result = await caller.byok.listSupportedModels();

        expect(result.anthropic).toEqual(['Claude Fixture (anthropic/claude-fixture)']);
        expect(result.bedrock).toEqual(['Claude Fixture (anthropic/claude-fixture)']);
        expect(result['byteplus-coding']).toContain(
          'ByteDance-Seed-Code (byteplus-coding/bytedance-seed-code)'
        );
      } finally {
        await db.delete(modelsByProvider).where(eq(modelsByProvider.id, snapshot.id));
      }
    });
  });

  describe('direct cloud providers', () => {
    const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

    afterEach(() => {
      if (originalTargetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
      else process.env.VERCEL_TARGET_ENV = originalTargetEnv;
    });

    test('creates direct Bedrock and Vertex keys outside production', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(caller.byok.experimentalByokEnabled({})).resolves.toBe(true);
      await expect(
        caller.byok.create({
          provider_id: 'bedrock-byok',
          api_key: JSON.stringify(BEDROCK_IAM_CREDENTIALS),
        })
      ).resolves.toMatchObject({ provider_id: 'bedrock-byok' });
      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'vertex-byok',
          api_key: JSON.stringify({
            type: 'service_account',
            project_id: 'example-project',
            private_key: 'private-key',
            client_email: 'gateway@example-project.iam.gserviceaccount.com',
          }),
        })
      ).resolves.toMatchObject({ provider_id: 'vertex-byok' });
    });

    test('rejects malformed direct cloud credentials', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.byok.create({ provider_id: 'bedrock-byok', api_key: '{"accessKeyId":"AKIA"}' })
      ).rejects.toThrow('Invalid credentials for provider: bedrock-byok');
      await expect(
        caller.byok.create({ provider_id: 'vertex-byok', api_key: '{"project_id":"p"}' })
      ).rejects.toThrow('Invalid credentials for provider: vertex-byok');
    });

    test('rejects direct cloud keys in production outside the Kilo organization', async () => {
      process.env.VERCEL_TARGET_ENV = 'production';
      const caller = await createCallerForUser(ownerUser.id);

      await expect(caller.byok.experimentalByokEnabled({})).resolves.toBe(false);
      await expect(
        caller.byok.experimentalByokEnabled({ organizationId: organizationA.id })
      ).resolves.toBe(false);
      await expect(
        caller.byok.create({
          organizationId: organizationA.id,
          provider_id: 'bedrock-byok',
          api_key: JSON.stringify(BEDROCK_IAM_CREDENTIALS),
        })
      ).rejects.toThrow('Provider bedrock-byok is not available yet.');
      await expect(
        caller.byok.create({ provider_id: 'nvidia-byok', api_key: 'nvidia-key' })
      ).resolves.toMatchObject({ provider_id: 'nvidia-byok' });
    });
  });

  describe('deprecated codestral provider', () => {
    test('declines to test a legacy codestral key with a deprecation message', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const key = await caller.byok.create({ provider_id: 'codestral', api_key: 'stored-secret' });

      await expect(caller.byok.testApiKey({ id: key.id })).resolves.toEqual({
        success: false,
        message: 'Codestral is deprecated and its API key can no longer be tested.',
      });
    });
  });

  describe('Coding Plan-installed credentials', () => {
    test('rejects removed dedicated provider identity in manual creation requests', async () => {
      const caller = await createCallerForUser(ownerUser.id);

      await expect(
        caller.byok.create({
          provider_id: 'minimax-token-plan-plus-managed' as never,
          api_key: 'not-supported',
        })
      ).rejects.toThrow();
    });

    async function createInstalledMiniMaxKey() {
      const encrypted = encryptApiKey('installed-minimax-key', BYOK_ENCRYPTION_KEY);
      const [inventory] = await db
        .insert(coding_plan_key_inventory)
        .values({
          plan_id: 'minimax-token-plan-plus',
          provider_id: 'minimax',
          upstream_plan_id: 'minimax-installed-plan',
          encrypted_api_key: encrypted,
          credential_fingerprint: crypto.randomUUID(),
          status: 'assigned',
          assigned_to_user_id: ownerUser.id,
        })
        .returning();
      const [key] = await db
        .insert(byok_api_keys)
        .values({
          kilo_user_id: ownerUser.id,
          provider_id: 'minimax',
          encrypted_api_key: encrypted,
          management_source: 'coding_plan',
          created_by: ownerUser.id,
        })
        .returning();
      const now = new Date().toISOString();
      const [subscription] = await db
        .insert(coding_plan_subscriptions)
        .values({
          user_id: ownerUser.id,
          plan_id: 'minimax-token-plan-plus',
          provider_id: 'minimax',
          key_inventory_id: inventory.id,
          installed_byok_key_id: key.id,
          status: 'active',
          cost_microdollars: 20_000_000,
          billing_period_days: 30,
          current_period_start: now,
          current_period_end: now,
          credit_renewal_at: now,
        })
        .returning();
      return { key, subscription };
    }

    async function createInstalledBytePlusKey() {
      const encrypted = encryptApiKey('installed-byteplus-key', BYOK_ENCRYPTION_KEY);
      const [inventory] = await db
        .insert(coding_plan_key_inventory)
        .values({
          plan_id: 'byteplus-coding-plan-team-lite',
          provider_id: 'byteplus-coding',
          upstream_plan_id: 'byteplus-installed-plan',
          encrypted_api_key: encrypted,
          credential_fingerprint: crypto.randomUUID(),
          status: 'assigned',
          assigned_to_user_id: ownerUser.id,
        })
        .returning();
      const [key] = await db
        .insert(byok_api_keys)
        .values({
          kilo_user_id: ownerUser.id,
          provider_id: 'byteplus-coding',
          encrypted_api_key: encrypted,
          management_source: 'coding_plan',
          created_by: ownerUser.id,
        })
        .returning();
      const now = new Date().toISOString();
      const [subscription] = await db
        .insert(coding_plan_subscriptions)
        .values({
          user_id: ownerUser.id,
          plan_id: 'byteplus-coding-plan-team-lite',
          provider_id: 'byteplus-coding',
          key_inventory_id: inventory.id,
          installed_byok_key_id: key.id,
          status: 'active',
          cost_microdollars: 20_000_000,
          billing_period_days: 30,
          current_period_start: now,
          current_period_end: now,
          credit_renewal_at: now,
        })
        .returning();
      return { key, subscription };
    }

    test('identifies installed origin and blocks changing enabled state', async () => {
      const { key } = await createInstalledMiniMaxKey();
      const caller = await createCallerForUser(ownerUser.id);
      const listed = await caller.byok.list({});

      expect(listed[0].provider_id).toBe('minimax');
      expect(listed[0].management_source).toBe('coding_plan');
      await expect(caller.byok.setEnabled({ id: key.id, is_enabled: false })).rejects.toThrow(
        /read-only/i
      );

      const [unchangedKey] = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, key.id));
      expect(unchangedKey.is_enabled).toBe(true);
      expect(unchangedKey.management_source).toBe('coding_plan');
    });

    test('blocks replacing an installed MiniMax credential', async () => {
      const { key, subscription } = await createInstalledMiniMaxKey();
      const caller = await createCallerForUser(ownerUser.id);

      await expect(caller.byok.update({ id: key.id, api_key: 'replacement-key' })).rejects.toThrow(
        /read-only/i
      );

      const [unchangedKey] = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, key.id));
      const [updatedSubscription] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, subscription.id));

      expect(unchangedKey.encrypted_api_key).toStrictEqual(key.encrypted_api_key);
      expect(unchangedKey.management_source).toBe('coding_plan');
      expect(updatedSubscription.status).toBe('active');
      expect(updatedSubscription.installed_byok_key_id).toBe(key.id);
    });

    test('blocks deleting an installed coding-plan MiniMax key', async () => {
      const { key, subscription } = await createInstalledMiniMaxKey();
      const caller = await createCallerForUser(ownerUser.id);

      await expect(caller.byok.delete({ id: key.id })).rejects.toThrow(/read-only/i);

      const remainingKeys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, key.id));
      expect(remainingKeys).toHaveLength(1);

      const [updatedSubscription] = await db
        .select()
        .from(coding_plan_subscriptions)
        .where(eq(coding_plan_subscriptions.id, subscription.id));

      expect(updatedSubscription.status).toBe('active');
      expect(updatedSubscription.installed_byok_key_id).toBe(key.id);
    });

    test('blocks mutations to an installed BytePlus key while allowing it to remain listed', async () => {
      const { key } = await createInstalledBytePlusKey();
      const caller = await createCallerForUser(ownerUser.id);

      await expect(caller.byok.setEnabled({ id: key.id, is_enabled: false })).rejects.toThrow(
        /read-only/i
      );
      await expect(caller.byok.update({ id: key.id, api_key: 'replacement-key' })).rejects.toThrow(
        /read-only/i
      );
      await expect(caller.byok.delete({ id: key.id })).rejects.toThrow(/read-only/i);
      await expect(caller.byok.list({})).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: key.id,
            provider_id: 'byteplus-coding',
            management_source: 'coding_plan',
          }),
        ])
      );
    });

    test('still deletes a user-owned key', async () => {
      const caller = await createCallerForUser(ownerUser.id);
      const created = await caller.byok.create({ provider_id: 'anthropic', api_key: 'user-key' });

      await expect(caller.byok.delete({ id: created.id })).resolves.toEqual({ success: true });

      const remainingKeys = await db
        .select()
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, created.id));
      expect(remainingKeys).toHaveLength(0);
    });
  });

  describe('cross-organization security', () => {
    test('should not allow user from org A to access keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'anthropic',
        api_key: 'org-b-secret-key',
      });

      // User from org A should not see org B's keys
      await expect(callerA.byok.list({ organizationId: organizationB.id })).rejects.toThrow(
        'You do not have access to this organization'
      );
    });

    test('should not allow user from org A to update keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      const keyB = await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'openai',
        api_key: 'org-b-key',
      });

      // User from org A tries to update org B's key
      await expect(
        callerA.byok.update({
          organizationId: organizationA.id,
          id: keyB.id,
          api_key: 'malicious-update',
        })
      ).rejects.toThrow('BYOK key not found');
    });

    test('should not allow user from org A to delete keys from org B', async () => {
      const callerA = await createCallerForUser(ownerUser.id);
      const callerB = await createCallerForUser(otherOrgOwner.id);

      // Create key in org B
      const keyB = await callerB.byok.create({
        organizationId: organizationB.id,
        provider_id: 'anthropic',
        api_key: 'org-b-key',
      });

      // User from org A tries to delete org B's key (using wrong org ID)
      await expect(
        callerA.byok.delete({
          organizationId: organizationB.id,
          id: keyB.id,
        })
      ).rejects.toThrow('You do not have access to this organization');

      // Verify key still exists
      const keys = await callerB.byok.list({ organizationId: organizationB.id });
      expect(keys).toHaveLength(1);
    });
  });
});
