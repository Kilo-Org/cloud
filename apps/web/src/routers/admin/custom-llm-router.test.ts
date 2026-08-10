import { describe, expect, it, beforeEach } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { custom_llm2, type User } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { eq } from 'drizzle-orm';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';

let admin: User;
let nonAdmin: User;

const validDefinition: CustomLlmDefinition = {
  internal_id: 'custom-gpt-4',
  display_name: 'Custom GPT-4',
  context_length: 128000,
  max_completion_tokens: 4096,
  base_url: 'https://api.openai.com/v1',
  organization_ids: ['org_test_123'],
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `custom-llm-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `custom-llm-user-${Math.random()}@example.com`,
  });
});

describe('adminCustomLlmRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.customLlm.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  describe('upsert', () => {
    it('creates a new custom LLM with encrypted API key and clean definition', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-1';

      const result = await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-test-secret-key-123' },
      });

      expect(result.public_id).toBe(publicId);
      expect(result.definition.display_name).toBe('Custom GPT-4');
      expect((result.definition as Record<string, unknown>).api_key).toBeUndefined();
      expect((result as Record<string, unknown>).encrypted_api_key).toBeUndefined();

      // Verify row in DB has encrypted key and clean definition
      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));

      expect(row).toBeDefined();
      expect(row.encrypted_api_key).toBeDefined();
      expect((row.definition as Record<string, unknown>).api_key).toBeUndefined();
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.api_key).toBe('sk-test-secret-key-123');
    });

    it('quietly migrates legacy api_key from definition JSON on save', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-legacy-key';

      const result = await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: {
          ...validDefinition,
          api_key: 'sk-legacy-migrated-key',
        } as CustomLlmDefinition,
      });

      expect(result.public_id).toBe(publicId);
      expect((result.definition as Record<string, unknown>).api_key).toBeUndefined();

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));
      expect(row).toBeDefined();
      expect((row.definition as Record<string, unknown>).api_key).toBeUndefined();
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.api_key).toBe('sk-legacy-migrated-key');
    });

    it('quietly migrates legacy google_service_account from definition JSON on save', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-legacy-gsa';

      const gsa = {
        type: 'service_account' as const,
        project_id: 'test-project',
        private_key_id: 'pkid',
        private_key: 'pk-secret',
        client_email: 'svc@test-project.iam.gserviceaccount.com',
        client_id: '123',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/svc',
      };

      const result = await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: {
          ...validDefinition,
          google_service_account: gsa,
        } as unknown as CustomLlmDefinition,
      });

      expect(result.public_id).toBe(publicId);
      expect((result.definition as Record<string, unknown>).google_service_account).toBeUndefined();

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));
      expect(row).toBeDefined();
      expect((row.definition as Record<string, unknown>).google_service_account).toBeUndefined();
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.project_id).toBe('test-project');
      expect(decrypted.private_key).toBe('pk-secret');
    });

    it('discards legacy credentials from definition if credentials are provided separately', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-discard-legacy';

      const result = await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: {
          ...validDefinition,
          api_key: 'sk-old-to-discard',
        } as CustomLlmDefinition,
        credentials: { type: 'api_key', api_key: 'sk-new-chosen-key' },
      });

      expect(result.public_id).toBe(publicId);
      expect((result.definition as Record<string, unknown>).api_key).toBeUndefined();

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.api_key).toBe('sk-new-chosen-key');
    });

    it('rejects creating new custom LLM when credentials are completely missing', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-no-key';

      await expect(
        caller.admin.customLlm.upsert({
          public_id: publicId,
          definition: validDefinition,
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Credentials are required'),
      });
    });

    it('updates existing custom LLM preserving existing encrypted key when credentials are omitted', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-update-preserve';

      await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-initial-secret' },
      });

      const updated = await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: {
          ...validDefinition,
          display_name: 'Updated Name',
        },
      });

      expect(updated.definition.display_name).toBe('Updated Name');

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.api_key).toBe('sk-initial-secret');
    });

    it('updates existing custom LLM rotating encrypted key when new credentials are provided', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-update-rotate';

      await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-initial-secret' },
      });

      await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-rotated-secret' },
      });

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));
      const decrypted = JSON.parse(decryptApiKey(row.encrypted_api_key!, BYOK_ENCRYPTION_KEY));
      expect(decrypted.api_key).toBe('sk-rotated-secret');
    });
  });

  describe('list', () => {
    it('lists custom LLMs without exposing encrypted_api_key in payload', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-list';

      await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-secret-never-expose' },
      });

      const listResult = await caller.admin.customLlm.list();
      const item = listResult.items.find(i => i.public_id === publicId);

      expect(item).toBeDefined();
      expect(item!.public_id).toBe(publicId);
      expect((item as Record<string, unknown>).encrypted_api_key).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('deletes a custom LLM by public_id', async () => {
      const caller = await createCallerForUser(admin.id);
      const publicId = 'kilo-internal/test-model-delete';

      await caller.admin.customLlm.upsert({
        public_id: publicId,
        definition: validDefinition,
        credentials: { type: 'api_key', api_key: 'sk-secret' },
      });

      const result = await caller.admin.customLlm.delete({ public_id: publicId });
      expect(result.success).toBe(true);

      const [row] = await db.select().from(custom_llm2).where(eq(custom_llm2.public_id, publicId));

      expect(row).toBeUndefined();
    });
  });
});
