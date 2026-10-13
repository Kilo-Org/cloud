import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { ai_gateway_config, type User } from '@kilocode/db/schema';
import {
  CUSTOM_PRICING_MAX_COUNT,
  CustomPricingConfigSchema,
  type CustomPricingConfig,
  type CustomPricingModelConfig,
} from '@kilocode/db/schema-types';
import { GEMINI_FLASH_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

const modelA: CustomPricingModelConfig = {
  model: 'provider/model-a',
  pricing: {
    prompt_per_million: 1,
    completion_per_million: 5,
    input_cache_read_per_million: 0.1,
    input_cache_write_per_million: null,
  },
  discountPercentage: 50,
  fallbackOnly: false,
};

const config: CustomPricingConfig = {
  models: [modelA, { ...modelA, model: 'provider/model-b', fallbackOnly: true }],
};

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `gateway-custom-pricing-admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `gateway-custom-pricing-user-${Math.random()}@example.com`,
  });
});

describe('CustomPricingConfigSchema', () => {
  it('accepts valid pricing', () => {
    expect(CustomPricingConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects duplicate models', () => {
    expect(CustomPricingConfigSchema.safeParse({ models: [modelA, modelA] }).success).toBe(false);
  });

  it.each([
    ['a negative price', { ...modelA, pricing: { ...modelA.pricing, prompt_per_million: -1 } }],
    [
      'an infinite price',
      { ...modelA, pricing: { ...modelA.pricing, completion_per_million: Infinity } },
    ],
    ['a zero discount', { ...modelA, discountPercentage: 0 }],
    ['a fractional discount', { ...modelA, discountPercentage: 12.5 }],
    ['an uppercase model ID', { ...modelA, model: 'Provider/Model' }],
  ])('rejects %s', (_name, model) => {
    expect(CustomPricingConfigSchema.safeParse({ models: [model] }).success).toBe(false);
  });

  it('rejects more than the maximum number of models', () => {
    const models = Array.from({ length: CUSTOM_PRICING_MAX_COUNT + 1 }, (_, index) => ({
      ...modelA,
      model: `provider/model-${index}`,
    }));
    expect(CustomPricingConfigSchema.safeParse({ models }).success).toBe(false);
  });
});

describe('adminGatewayCustomPricingRouter', () => {
  it('rejects a non-admin caller', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(caller.admin.gatewayCustomPricing.get()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.gatewayCustomPricing.set({ config })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns built-in pricing and no stored config when unset', async () => {
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.gatewayCustomPricing.get();

    expect(result.config).toBeNull();
    expect(result.builtIn).toContainEqual({
      model: GEMINI_FLASH_CURRENT_MODEL_ID,
      pricing: {
        prompt_per_million: 0.75,
        completion_per_million: 3.75,
        input_cache_read_per_million: 0.075,
        input_cache_write_per_million: 0.0416666666667,
      },
      discountPercentage: 50,
      fallbackOnly: false,
    });
  });

  it('stores, updates, and clears pricing without touching other gateway config', async () => {
    const preferredModels = { models: ['provider/model-a'] };
    await db
      .insert(ai_gateway_config)
      .values({ config: { vercel_routing_percentage: 10 }, preferred_models: preferredModels });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.gatewayCustomPricing.set({ config });
    expect((await caller.admin.gatewayCustomPricing.get()).config).toEqual(config);

    const updated: CustomPricingConfig = { models: [{ ...modelA, discountPercentage: 25 }] };
    await caller.admin.gatewayCustomPricing.set({ config: updated });
    expect((await caller.admin.gatewayCustomPricing.get()).config).toEqual(updated);

    await caller.admin.gatewayCustomPricing.set({ config: null });
    expect((await caller.admin.gatewayCustomPricing.get()).config).toBeNull();

    const [row] = await db.select().from(ai_gateway_config);
    expect(row).toMatchObject({
      config: { vercel_routing_percentage: 10 },
      preferred_models: preferredModels,
      custom_pricing: null,
    });
  });

  it('rejects invalid pricing without writing', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.gatewayCustomPricing.set({ config: { models: [modelA, modelA] } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await db.select().from(ai_gateway_config)).toEqual([]);
  });
});
