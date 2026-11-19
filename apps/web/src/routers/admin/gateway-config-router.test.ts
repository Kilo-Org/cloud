import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  ai_gateway_config,
  anthropic_user_profile_deletions,
  organizations,
  type User,
} from '@kilocode/db/schema';
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
  vercel_routing_opt_out_models: [' MoonshotAI/Kimi-K3 ', 'moonshotai/kimi-k3', 'openai/gpt-6'],
  note: 'Holding opt-outs',
};

const normalizedOptOutModels = ['moonshotai/kimi-k3', 'openai/gpt-6'];

describe('adminGatewayConfigRouter', () => {
  it('stores the normalized opt-out list and reads it back', async () => {
    const caller = await createCallerForUser(admin.id);

    const saved = await caller.admin.gatewayConfig.set(input);
    expect({
      vercel_routing_opt_out_models: saved.vercel_routing_opt_out_models,
      note: saved.note,
    }).toEqual({
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    const [row] = await db.select().from(ai_gateway_config);
    expect(row.config).toMatchObject({
      vercel_routing_opt_out_models: normalizedOptOutModels,
      note: 'Holding opt-outs',
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
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
    });
    await caller.admin.gatewayConfig.set(input);

    await expect(caller.admin.gatewayConfig.getOrganizationFeatures()).resolves.toEqual({
      experimental_byok: [organizationId],
      enkrypt_output_guardrail: [organizationId],
      gateway_settings: [organizationId],
    });
    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
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
    });

    await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
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
        })
      ).resolves.toEqual([]);
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it.each(['experimental_byok', 'enkrypt_output_guardrail', 'gateway_settings'] as const)(
      'rejects invalid IDs in %s without writing configuration',
      async feature => {
        const caller = await createCallerForUser(admin.id);

        await expect(
          caller.admin.gatewayConfig.previewOrganizationFeatures({
            experimental_byok: [],
            enkrypt_output_guardrail: [],
            gateway_settings: [],
            [feature]: ['not-an-id'],
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(await db.select().from(ai_gateway_config)).toEqual([]);
      }
    );

    it.each(['experimental_byok', 'enkrypt_output_guardrail', 'gateway_settings'] as const)(
      'rejects more than 1000 entries in %s before deduplication',
      async feature => {
        const caller = await createCallerForUser(admin.id);

        await expect(
          caller.admin.gatewayConfig.previewOrganizationFeatures({
            experimental_byok: [],
            enkrypt_output_guardrail: [],
            gateway_settings: [],
            [feature]: Array.from(
              { length: ORGANIZATION_FEATURE_ORGANIZATIONS_MAX_COUNT + 1 },
              () => '9d278969-5453-4ae3-a51f-a8d2274a7b56'
            ),
          })
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(await db.select().from(ai_gateway_config)).toEqual([]);
      }
    );

    it('leaves existing routing configuration and organization features unchanged', async () => {
      const caller = await createCallerForUser(admin.id);
      const organization = await createTestOrganization('Unsaved organization', admin.id, 0);
      await caller.admin.gatewayConfig.set(input);
      await caller.admin.gatewayConfig.setOrganizationFeatures({
        experimental_byok: [],
        enkrypt_output_guardrail: [],
        gateway_settings: ['9d278969-5453-4ae3-a51f-a8d2274a7b56'],
      });
      const beforePreview = await db.select().from(ai_gateway_config);

      await expect(
        caller.admin.gatewayConfig.previewOrganizationFeatures({
          experimental_byok: [organization.id],
          enkrypt_output_guardrail: [],
          gateway_settings: [],
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
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });
  });

  describe('Anthropic user profiles', () => {
    const organizationId = '9d278969-5453-4ae3-a51f-a8d2274a7b56';
    const settings = {
      enabled: true,
      start_at: '2026-12-01T09:30:00.000Z',
      opted_in_user_ids: ['user-1', 'user-1', 'user-2'],
      opted_in_organization_ids: [organizationId.toUpperCase()],
      opted_out_user_ids: ['user-3'],
      opted_out_organization_ids: [],
    };
    const normalizedSettings = {
      ...settings,
      opted_in_user_ids: ['user-1', 'user-2'],
      opted_in_organization_ids: [organizationId],
    };

    it('returns the disabled defaults when nothing is stored', async () => {
      const caller = await createCallerForUser(admin.id);

      await expect(caller.admin.gatewayConfig.getAnthropicUserProfiles()).resolves.toEqual({
        enabled: false,
        start_at: null,
        opted_in_user_ids: [],
        opted_in_organization_ids: [],
        opted_out_user_ids: [],
        opted_out_organization_ids: [],
      });
    });

    it('stores normalized settings and reads them back', async () => {
      const caller = await createCallerForUser(admin.id);

      await expect(caller.admin.gatewayConfig.setAnthropicUserProfiles(settings)).resolves.toEqual(
        normalizedSettings
      );
      await expect(caller.admin.gatewayConfig.getAnthropicUserProfiles()).resolves.toEqual(
        normalizedSettings
      );
    });

    it('replaces the whole stored object when saved again', async () => {
      const caller = await createCallerForUser(admin.id);

      await caller.admin.gatewayConfig.setAnthropicUserProfiles(settings);
      await caller.admin.gatewayConfig.setAnthropicUserProfiles({
        enabled: false,
        start_at: null,
        opted_in_user_ids: [],
        opted_in_organization_ids: [],
        opted_out_user_ids: [],
        opted_out_organization_ids: [],
      });

      await expect(caller.admin.gatewayConfig.getAnthropicUserProfiles()).resolves.toMatchObject({
        enabled: false,
        start_at: null,
        opted_in_user_ids: [],
      });
    });

    it('rejects an ID that is both opted in and opted out without writing', async () => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.gatewayConfig.setAnthropicUserProfiles({
          ...settings,
          opted_out_user_ids: ['user-1'],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.admin.gatewayConfig.setAnthropicUserProfiles({
          ...settings,
          opted_out_organization_ids: [organizationId],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it('rejects a start date that is not an ISO date-time and an invalid organization ID', async () => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.gatewayConfig.setAnthropicUserProfiles({ ...settings, start_at: 'tomorrow' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        caller.admin.gatewayConfig.setAnthropicUserProfiles({
          ...settings,
          opted_in_organization_ids: ['not-an-id'],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await db.select().from(ai_gateway_config)).toEqual([]);
    });

    it('keeps the other configuration keys when saved, and when they are saved', async () => {
      const caller = await createCallerForUser(admin.id);

      await caller.admin.gatewayConfig.set(input);
      await caller.admin.gatewayConfig.setOrganizationFeatures({
        experimental_byok: [],
        enkrypt_output_guardrail: [],
        gateway_settings: [organizationId],
      });
      await caller.admin.gatewayConfig.setAnthropicUserProfiles(settings);

      await expect(caller.admin.gatewayConfig.get()).resolves.toMatchObject({
        vercel_routing_opt_out_models: normalizedOptOutModels,
        note: 'Holding opt-outs',
      });
      await expect(caller.admin.gatewayConfig.getOrganizationFeatures()).resolves.toMatchObject({
        gateway_settings: [organizationId],
      });

      await caller.admin.gatewayConfig.set({ ...input, note: 'Updated' });
      await expect(caller.admin.gatewayConfig.getAnthropicUserProfiles()).resolves.toEqual(
        normalizedSettings
      );
    });

    it('rejects non-admin users', async () => {
      const user = await insertTestUser();
      const caller = await createCallerForUser(user.id);

      await expect(
        caller.admin.gatewayConfig.setAnthropicUserProfiles(settings)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.admin.gatewayConfig.listAnthropicUserProfileDeletions()
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('lists deleted profiles newest first', async () => {
      const caller = await createCallerForUser(admin.id);
      await db.insert(anthropic_user_profile_deletions).values([
        {
          user_profile_id: 'uprof_old',
          reason: 'unlinked',
          deleted_at: '2026-11-10T00:00:00.000Z',
        },
        {
          user_profile_id: 'uprof_new',
          reason: 'user_blocked',
          kilo_user_id: admin.id,
          deleted_at: '2026-11-18T00:00:00.000Z',
        },
        {
          user_profile_id: 'uprof_mid',
          reason: 'unlinked',
          deleted_at: '2026-11-15T00:00:00.000Z',
        },
      ]);

      const rows = await caller.admin.gatewayConfig.listAnthropicUserProfileDeletions();

      expect(rows.map(row => row.user_profile_id)).toEqual(['uprof_new', 'uprof_mid', 'uprof_old']);
      expect(rows[0]).toMatchObject({ reason: 'user_blocked', kilo_user_id: admin.id });
    });
  });
});
