import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { custom_llm2 } from '@kilocode/db/schema';
import {
  CustomLlmCredentialsSchema,
  CustomLlmDefinitionSchema,
  type EncryptedData,
} from '@kilocode/db/schema-types';
import { asc, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';

const publicIdSchema = z
  .string()
  .min(1, 'public_id is required')
  .startsWith(CUSTOM_LLM_PREFIX, `public_id must start with "${CUSTOM_LLM_PREFIX}"`);

const UpsertCustomLlmSchema = z.object({
  public_id: publicIdSchema,
  definition: CustomLlmDefinitionSchema,
  credentials: CustomLlmCredentialsSchema.optional(),
});

const DeleteCustomLlmSchema = z.object({
  public_id: publicIdSchema,
});

export const adminCustomLlmRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    const rows = await db
      .select({
        public_id: custom_llm2.public_id,
        definition: custom_llm2.definition,
      })
      .from(custom_llm2)
      .orderBy(asc(custom_llm2.public_id));
    return { items: rows };
  }),

  upsert: adminProcedure.input(UpsertCustomLlmSchema).mutation(async ({ input }) => {
    const existing = await db.query.custom_llm2.findFirst({
      where: eq(custom_llm2.public_id, input.public_id),
    });

    let encrypted_api_key: EncryptedData | undefined = undefined;

    if (input.credentials) {
      if (!BYOK_ENCRYPTION_KEY) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'BYOK_ENCRYPTION_KEY is not configured',
        });
      }
      encrypted_api_key = encryptApiKey(JSON.stringify(input.credentials), BYOK_ENCRYPTION_KEY);
    } else if (existing?.encrypted_api_key) {
      encrypted_api_key = existing.encrypted_api_key;
    } else {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Credentials are required when creating a custom LLM',
      });
    }

    if (existing) {
      const [updated] = await db
        .update(custom_llm2)
        .set({
          definition: input.definition,
          encrypted_api_key,
        })
        .where(eq(custom_llm2.public_id, input.public_id))
        .returning({
          public_id: custom_llm2.public_id,
          definition: custom_llm2.definition,
        });

      return updated;
    }

    const [inserted] = await db
      .insert(custom_llm2)
      .values({
        public_id: input.public_id,
        definition: input.definition,
        encrypted_api_key,
      })
      .returning({
        public_id: custom_llm2.public_id,
        definition: custom_llm2.definition,
      });

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
