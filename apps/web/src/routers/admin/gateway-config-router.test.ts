import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, organizations, type User } from '@kilocode/db/schema';
import {
  ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT,
  VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-config';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { eq } from 'drizzle-orm';

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `gateway-config-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

const input = {
  vercel_routing_enabled: false,
  vercel_routing_opt_out_models: [' MoonshotAI/Kimi-K3 ', 'moonshotai/kimi-k3', 'openai/gpt-6'],
  note: 'Holding opt-outs',
};

const normalizedOptOutModels = ['moonshotai/kimi-k3', 'openai/gpt-6'];

describe('adminGatewayConfigRouter', () => {
  it('stores the normalized opt-out list and reads it back', async () => {
    const caller = await createCallerForUser(admin.id);

    const saved = await caller.admin.gatewayConfig.set(input);
    expect({
      vercel_routing_enabled: saved.vercel_routing_enabled,
      vercel_routing_opt_out_models: saved.vercel_routing_opt_out_models,
      note: saved.note,
    }).toEqual({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    const [row] = await db.select().from(ai_gateway_config);
    expect(row.config).toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });
  });

  it('rejects a blank opt-out entry without writing', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.set({
        ...input,
        vercel_routing_opt_out_models: ['moonshotai/kimi-k3', ''],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  it('rejects an over-length opt-out entry without writing', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.set({
        ...input,
        vercel_routing_opt_out_models: ['x'.repeat(VERCEL_ROUTING_OPT_OUT_MODEL_MAX_LENGTH + 1)],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  it('keeps organization features when the routing configuration is saved', async () => {
    const caller = await createCallerForUser(admin.id);
    const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

    await caller.admin.gatewayConfig.setOrganizationFeatures({
      experimental_byok: [organizationId.toUpperCase()],
      enkrypt_output_guardrail: [organizationId.toUpperCase()],
      gateway_settings: [organizationId],
      request_logs: [organizationId.toUpperCase()],
    });
    await caller.admin.gatewayConfig.set(input);

    await expect(caller.admin.gatewayConfig.getOrganizationFeatures()).resolves.toEqual({
      experimental_byok: [organizationId],
      enkrypt_output_guardrail: [organizationId],
      gateway_settings: [organizationId],
      request_logs: [organizationId],
    });
    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
    });
  });

  it('keeps the routing configuration when organization features are saved', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.admin.gatewayConfig.set(input);
    await caller.admin.gatewayConfig.setOrganizationFeatures({
      experimental_byok: [],
      enkrypt_output_guardrail: [],
      gateway_settings: ['00000000-0000-4000-8000-000000000001'],
      request_logs: [],
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
      vercel_routing_enabled: false,
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });
  });

  it('rejects an organization feature entry that is not an organization ID', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.gatewayConfig.setOrganizationFeatures({
        experimental_byok: ['not-an-id'],
        enkrypt_output_guardrail: [],
        gateway_settings: [],
        request_logs: [],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });

  describe('previewOrganizationFeatures', () => {
    it('normalizes organization IDs and deduplicates them across feature lists', async () => {
      const caller = await createCallerForUser(admin.id);
      const first = await createTestOrganization('First preview organization', admin.id, 0);
      const second = await createTestOrganization('Second preview organization', admin.id, 0);

      const preview = await caller.admin.gatewayConfig.previewOrganizationFeatures({
        experimental_byok: [first.id.toUpperCase(), first.id],
        enkrypt_output_guardrail: [first.id, second.id],
        gateway_settings: [first.id.toUpperCase(), second.id.toUpperCase(), second.id],
        request_logs: [],
      });

      expect(preview).toHaveLength(2);
      expect(preview).toEqual(
        expect.arrayContaining([
          { id: first.id, name: first.name, isDeleted: false },
          { id: second.id, name: second.name, isDeleted: false },
        ])
      );
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it('omits missing IDs and organizations not requested', async () => {
      const caller = await createCallerForUser(admin.id);
      const organization = await createTestOrganization('Requested organization', admin.id, 0);
      await createTestOrganization('Unrequested organization', admin.id, 0);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [crypto.randomUUID()],
          enkrypt_output_guardrail: [],
          gateway_settings: [organization.id, crypto.randomUUID()],
          request_logs: [],
        })
      ).resolves.toEqual([{ id: organization.id, name: organization.name, isDeleted: false }]);
    });

    it('includes deleted organizations with isDeleted set to true', async () => {
      const caller = await createCallerForUser(admin.id);
      const organization = await createTestOrganization('Deleted organization', admin.id, 0);
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [organization.id],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
        })
      ).resolves.toEqual([{ id: organization.id, name: organization.name, isDeleted: true }]);
    });

    it('returns an empty preview for empty feature lists without creating configuration', async () => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
        })
      ).resolves.toEqual([]);
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it.each([
      'experimental_byok',
      'enkrypt_output_guardrail',
      'gateway_settings',
      'request_logs',
    ] as const)('rejects invalid IDs in %s without writing configuration', async feature => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
          [feature]: ['not-an-id'],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it.each([
      'experimental_byok',
      'enkrypt_output_guardrail',
      'gateway_settings',
      'request_logs',
    ] as const)('rejects more than 1000 entries in %s before deduplication', async feature => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
          [feature]: Array.from(
            { length: ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT + 1 },
            () => '9d278969-5453-4ae3-a51f-a8d2274a7b56'
          ),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it('leaves existing routing configuration and organization features unchanged', async () => {
      const caller = await createCallerForUser(admin.id);
      const organization = await createTestOrganization('Unsaved organization', admin.id, 0);
      await caller.admin.gatewayConfig.set(input);
      await caller.admin.gatewayConfig.setOrganizationFeatures({
        experimental_byok: [],
        enkrypt_output_guardrail: [],
        gateway_settings: ['9d278969-5453-4ae3-a51f-a8d2274a7b56'],
        request_logs: [],
      });
      const beforePreview = await db.select().from(ai_gateway_config);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [organization.id],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
        })
      ).resolves.toEqual([{ id: organization.id, name: organization.name, isDeleted: false }]);

      expect(await db.select().from(ai_gateway_config)).toEqual(beforePreview);
    });

    it('rejects non-admin users', async () => {
      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);
      const organization = await createTestOrganization('Private organization', admin.id, 0);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [organization.id],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
          request_logs: [],
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });
  });
});
