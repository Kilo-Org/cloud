import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { custom_llm2 } from '@kilocode/db/schema';
import { CustomLlmDefinitionSchema } from '@kilocode/db/schema-types';
import { asc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const KILO_INTERNAL_PREFIX = 'kilo-internal/';

const publicIdSchema = z
  .string()
  .min(1, 'public_id is required')
  .startsWith(KILO_INTERNAL_PREFIX, `public_id must start with "${KILO_INTERNAL_PREFIX}"`);

const UpsertCustomLlmSchema = z.object({
  public_id: publicIdSchema,
  definition: CustomLlmDefinitionSchema,
});

const DeleteCustomLlmSchema = z.object({
  public_id: publicIdSchema,
});

export const adminCustomLlmRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    const rows = await db.select().from(custom_llm2).orderBy(asc(custom_llm2.public_id));
    return { items: rows };
  }),

  upsert: adminProcedure.input(UpsertCustomLlmSchema).mutation(async ({ input }) => {
    const existing = await db.query.custom_llm2.findFirst({
      where: eq(custom_llm2.public_id, input.public_id),
    });

    if (existing) {
      const [updated] = await db
        .update(custom_llm2)
        .set({ definition: input.definition })
        .where(eq(custom_llm2.public_id, input.public_id))
        .returning();

      return updated;
    }

    const [inserted] = await db
      .insert(custom_llm2)
      .values({
        public_id: input.public_id,
        definition: input.definition,
      })
      .returning();

    return inserted;
  }),

  delete: adminProcedure.input(DeleteCustomLlmSchema).mutation(async ({ input }) => {
    const result = await db.delete(custom_llm2).where(eq(custom_llm2.public_id, input.public_id));

    if ((result.rowCount ?? 0) === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Custom LLM with public_id "${input.public_id}" not found`,
      });
    }

    return { success: true };
  }),
});
