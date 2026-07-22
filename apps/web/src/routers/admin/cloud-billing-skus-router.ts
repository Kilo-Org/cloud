import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cloudBillingSkuIdSchema,
  createCloudBillingSkuInputSchema,
  normalizeCloudBillingSkuRate,
} from '@/lib/cloud-billing-sku';
import { cloud_billing_sku, type CloudBillingSku } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod';

export type SerializedCloudBillingSku = Omit<CloudBillingSku, 'created_at'> & {
  created_at: string;
};

export function serializeCloudBillingSku(sku: CloudBillingSku): SerializedCloudBillingSku {
  return {
    ...sku,
    rate_cents_per_unit: normalizeCloudBillingSkuRate(sku.rate_cents_per_unit),
    created_at: new Date(sku.created_at).toISOString(),
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return postgresErrorCode(error.cause);
  return undefined;
}

export const cloudBillingSkusRouter = createTRPCRouter({
  list: adminProcedure.query(async (): Promise<SerializedCloudBillingSku[]> => {
    const rows = await db
      .select()
      .from(cloud_billing_sku)
      .orderBy(desc(cloud_billing_sku.created_at));
    return rows.map(serializeCloudBillingSku);
  }),

  create: adminProcedure
    .input(createCloudBillingSkuInputSchema)
    .mutation(async ({ input, ctx }): Promise<SerializedCloudBillingSku> => {
      try {
        const [created] = await db
          .insert(cloud_billing_sku)
          .values({
            id: input.id,
            name: input.name,
            description: input.description,
            unit: input.unit,
            rate_cents_per_unit: input.rate_cents_per_unit,
            created_by_user_id: ctx.user.id,
          })
          .returning();
        return serializeCloudBillingSku(created);
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          throw new TRPCError({ code: 'CONFLICT', message: 'A billing SKU with this ID exists' });
        }
        throw error;
      }
    }),

  disable: adminProcedure
    .input(z.object({ id: cloudBillingSkuIdSchema }))
    .mutation(async ({ input }): Promise<SerializedCloudBillingSku> => {
      const [updated] = await db
        .update(cloud_billing_sku)
        .set({ accepts_new_usage: false })
        .where(eq(cloud_billing_sku.id, input.id))
        .returning();
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Billing SKU not found' });
      }
      return serializeCloudBillingSku(updated);
    }),
});
