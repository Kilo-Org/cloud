import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import type { CustomPricingConfig } from '@kilocode/db/schema-types';
import { CUSTOM_PRICING_FALLBACK_CONFIG } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

const config: CustomPricingConfig = {
  models: [
    {
      model: 'vendor/model-a',
      discountPercentage: 20,
      pricing: [
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 0.8,
            completion_per_million: 4,
            input_cache_read_per_million: 0.08,
            input_cache_write_per_million: null,
          },
        },
      ],
    },
  ],
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `custom-pricing-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `custom-pricing-user-${Math.random()}@example.com`,
  });
});

describe('adminCustomPricingRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.customPricing.get()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.admin.customPricing.set({ config })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns the in-code fallback when unset', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(caller.admin.customPricing.get()).resolves.toEqual({
      config: null,
      fallback: CUSTOM_PRICING_FALLBACK_CONFIG,
    });
  });

  it('stores, updates, and clears the config without touching other columns', async () => {
    const preferredModels = { models: ['provider/model-a'] };
    await db.insert(ai_gateway_config).values({
      config: { vercel_routing_enabled: false },
      preferred_models: preferredModels,
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.customPricing.set({ config });
    expect((await caller.admin.customPricing.get()).config).toEqual(config);

    await caller.admin.customPricing.set({ config: { models: [] } });
    expect((await caller.admin.customPricing.get()).config).toEqual({ models: [] });

    await caller.admin.customPricing.set({ config: null });
    expect((await caller.admin.customPricing.get()).config).toBeNull();

    const [row] = await db.select().from(ai_gateway_config);
    expect(row).toMatchObject({
      config: { vercel_routing_enabled: false },
      preferred_models: preferredModels,
      custom_pricing: null,
    });
  });

  it('rejects an invalid config without writing', async () => {
    const caller = await createCallerForUser(admin.id);
    const [entry] = config.models;
    await expect(
      caller.admin.customPricing.set({
        config: {
          models: [{ ...entry, pricing: [{ ...entry.pricing[0], start_context_length: 1 }] }],
        },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });
});
