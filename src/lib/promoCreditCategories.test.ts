import { promoCategoriesOld } from '@/lib/promoCreditCategoriesOld';
import { promoCreditCategories } from './promoCreditCategories';

import * as z from 'zod';

const GuiCreditCategorySchema = z.object({
  credit_category: z.string(),
  adminUI_label: z.string().optional(),
  // test if this works?
  amount_usd: z.number().optional().describe('Amount in USD'),
  description: z.string().optional(),
  credit_expiry_date: z.date().optional(),
  expiry_hours: z.number().optional(),
});

const PromoCreditCategoryConfigCoreSchema = GuiCreditCategorySchema.extend({
  is_idempotent: z.boolean().optional(),
  total_redemptions_allowed: z.number().optional(),
  promotion_ends_at: z.date().optional(),
});

const PromoCreditCategoryConfigSchema = z.discriminatedUnion('is_user_selfservicable', [
  // Case 1: is_user_selfservicable is false or undefined
  PromoCreditCategoryConfigCoreSchema.extend({
    is_user_selfservicable: z.literal(false).optional(),
  }),
  // Case 2: is_user_selfservicable is true (requires amount_usd and is_idempotent: true)
  PromoCreditCategoryConfigCoreSchema.extend({
    is_user_selfservicable: z.literal(true),
    amount_usd: z.number(),
    is_idempotent: z.literal(true),
  }),
]);

describe('promoCreditCategories', () => {
  describe('user self servicable', () => {
    it('all should be idempotent', () => {
      for (const promo of promoCreditCategories) {
        if (promo.is_user_selfservicable) {
          expect(promo.is_idempotent).toBe(true);
        }
      }
    });

    it('all should have some amount of maximum redemptions', () => {
      for (const promo of promoCreditCategories) {
        if (promo.is_user_selfservicable) {
          expect(promo.total_redemptions_allowed).toBeDefined();
          expect(promo.total_redemptions_allowed).toBeGreaterThan(0);
        }
      }
    });

    it('all should have a dollar amount', () => {
      for (const promo of promoCreditCategories) {
        if (promo.is_user_selfservicable) {
          expect(typeof promo.amount_usd).toBe('number');
          expect(promo.amount_usd).toBeGreaterThan(0);
        }
      }
    });
  });

  it('all should have unique credit_category', () => {
    const categories = new Set<string>();
    for (const promo of promoCreditCategories) {
      expect(categories.has(promo.credit_category)).toBe(false);
      categories.add(promo.credit_category);
    }
  });

  it('everything in promoCategoriesOld is obsolete and nothing else is missing', () => {
    const oldCategorySet = new Set<string>(promoCategoriesOld.map(p => p.credit_category));

    for (const oldPromo of promoCategoriesOld) {
      expect(oldPromo.obsolete).toBe(true);
    }

    for (const promo of promoCreditCategories) {
      if (!oldCategorySet.has(promo.credit_category)) {
        if (promo.obsolete) {
          throw new Error(
            `Promo category ${promo.credit_category} should not be obsolete, or be moved to promoCategoriesOld`
          );
        }
      }
    }
  });

  it('all should match the PromoCreditCategoryConfigSchema', () => {
    for (const promo of promoCreditCategories) {
      expect(PromoCreditCategoryConfigSchema.safeParse(promo).success).toBe(true);
    }
  });
});
