import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { custom_llm2 } from '@kilocode/db/schema';
import {
  CustomLlmCredentialsSchema,
  CustomLlmDefinitionSchema,
  CustomLlmPublicIdSchema,
  type CustomLlmCredentialsEnvelope,
  type CustomLlmDefinition,
} from '@kilocode/db/schema-types';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { encryptCustomLlmCredentials } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/credentials-encryption';
import { DirectUserByokInferenceProviderIdSchema } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isUpstreamUrlPolicyEnforced } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-url-policy';
import {
  addAdminAuditMetadata,
  inputFieldTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

const publicIdSchema = z.string().trim().min(1, 'public_id is required');

function badRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}

/** The gateway treats a model with a free id as free, so Kilo must never charge for one. */
function assertPricingMatchesPublicId(publicId: string, definition: CustomLlmDefinition) {
  if (isFreeModel(publicId) && definition.pricing) {
    badRequest(`public_id "${publicId}" is a free model id, so pricing must not be set`);
  }
}

/**
 * The gateway refuses non-HTTPS upstreams wherever its URL policy applies, so
 * such a definition is refused at save time instead of failing every request.
 */
function assertBaseUrlUsesHttps(definition: CustomLlmDefinition) {
  if (!isUpstreamUrlPolicyEnforced()) return;
  if (new URL(definition.base_url).protocol !== 'https:') {
    badRequest('base_url must use https');
  }
}

/** A valid public id, unique ignoring case. Custom LLM lookups ignore case, so a case
 * variant of an existing row would shadow it or be shadowed by it. */
async function assertPublicIdIsValidAndUnique(publicId: string): Promise<string> {
  const parsedPublicId = CustomLlmPublicIdSchema.safeParse(publicId);
  if (!parsedPublicId.success) {
    badRequest(parsedPublicId.error.issues.map(issue => issue.message).join('; '));
  }
  const modelId = parsedPublicId.data;
  const [caseVariant] = await db
    .select({ public_id: custom_llm2.public_id })
    .from(custom_llm2)
    .where(
      and(sql`lower(${custom_llm2.public_id}) = ${modelId}`, ne(custom_llm2.public_id, modelId))
    )
    .limit(1);
  if (caseVariant) {
    badRequest(
      `public_id "${modelId}" differs only in case from the existing custom LLM "${caseVariant.public_id}"`
    );
  }
  return modelId;
}

/**
 * Routing resolves custom LLMs before any other upstream, so a new id must not
 * hide an OpenRouter or direct BYOK model. Existing rows keep their id, so this
 * only runs when an id is claimed.
 */
async function assertPublicIdIsClaimable(publicId: string) {
  const modelId = await assertPublicIdIsValidAndUnique(publicId);
  const directByokProvider = DirectUserByokInferenceProviderIdSchema.options.find(providerId =>
    modelId.startsWith(`${providerId}/`)
  );
  if (directByokProvider) {
    badRequest(`public_id must not use the direct BYOK prefix "${directByokProvider}/"`);
  }
  if (Object.hasOwn(await getOpenRouterModelsMetadataFromDatabase(), modelId)) {
    badRequest(`public_id "${modelId}" already exists in the OpenRouter model list`);
  }
}

/** A partner serves a catalog model, so its id must name one. */
async function assertPartnerPublicIdIsCatalogModel(publicId: string) {
  const modelId = await assertPublicIdIsValidAndUnique(publicId);
  if (!Object.hasOwn(await getOpenRouterModelsMetadataFromDatabase(), modelId)) {
    badRequest(
      `public_id "${modelId}" must exist in the OpenRouter model list when partner is set`
    );
  }
}

const UpsertCustomLlmSchema = z.object({
  public_id: publicIdSchema,
  definition: CustomLlmDefinitionSchema,
  credentials: CustomLlmCredentialsSchema.optional(),
});

const CopyCustomLlmSchema = z.object({
  source_public_id: publicIdSchema,
  public_id: publicIdSchema,
  display_name: z.string().trim().min(1, 'display_name is required'),
  internal_id: z.string().trim().min(1, 'internal_id must not be empty').optional(),
});

const DeleteCustomLlmSchema = z.object({
  public_id: publicIdSchema,
});

const SetCustomLlmEnabledSchema = z.object({
  public_id: publicIdSchema,
  is_enabled: z.boolean(),
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

  upsert: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'custom_llm.model.upsert',
        target: inputFieldTarget('other', 'public_id'),
      },
    })
    .input(UpsertCustomLlmSchema)
    .mutation(async ({ ctx, input }) => {
      assertPricingMatchesPublicId(input.public_id, input.definition);
      assertBaseUrlUsesHttps(input.definition);
      const existing = await db.query.custom_llm2.findFirst({
        where: eq(custom_llm2.public_id, input.public_id),
      });

      if (input.definition.partner) {
        // An existing partner stays editable after its model leaves the catalog.
        if (!existing?.definition.partner)
          await assertPartnerPublicIdIsCatalogModel(input.public_id);
      } else if (!existing || existing.definition.partner) {
        // A former partner's id names a catalog model, which a custom LLM must not hide.
        await assertPublicIdIsClaimable(input.public_id);
      }

      let encrypted_api_key: CustomLlmCredentialsEnvelope;

      if (input.credentials) {
        encrypted_api_key = await encryptCustomLlmCredentials({
          credentials: input.credentials,
          actorUserId: ctx.user.id,
        });
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

  copy: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'custom_llm.model.copy',
        target: inputFieldTarget('other', 'public_id'),
      },
    })
    .input(CopyCustomLlmSchema)
    .mutation(async ({ input }) => {
      addAdminAuditMetadata({ sourcePublicId: input.source_public_id });
      const source = await db.query.custom_llm2.findFirst({
        where: eq(custom_llm2.public_id, input.source_public_id),
      });

      if (!source) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Custom LLM with public_id "${input.source_public_id}" not found`,
        });
      }
      if (source.definition.partner) {
        badRequest('A partner custom LLM cannot be copied');
      }
      assertPricingMatchesPublicId(input.public_id, source.definition);
      await assertPublicIdIsClaimable(input.public_id);

      const [inserted] = await db
        .insert(custom_llm2)
        .values({
          public_id: input.public_id,
          definition: {
            ...source.definition,
            display_name: input.display_name,
            internal_id: input.internal_id,
          },
          encrypted_api_key: source.encrypted_api_key,
        })
        .onConflictDoNothing()
        .returning({
          public_id: custom_llm2.public_id,
          definition: custom_llm2.definition,
        });

      if (!inserted) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Custom LLM with public_id "${input.public_id}" already exists`,
        });
      }

      return inserted;
    }),

  setEnabled: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'custom_llm.model.set_enabled',
        target: inputFieldTarget('other', 'public_id'),
      },
    })
    .input(SetCustomLlmEnabledSchema)
    .mutation(async ({ input }) => {
      addAdminAuditMetadata({ isEnabled: input.is_enabled });
      const [updated] = await db
        .update(custom_llm2)
        .set({
          definition: sql`${custom_llm2.definition} || jsonb_build_object('is_enabled', ${input.is_enabled}::boolean)`,
        })
        .where(eq(custom_llm2.public_id, input.public_id))
        .returning({
          public_id: custom_llm2.public_id,
          definition: custom_llm2.definition,
        });

      if (!updated) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Custom LLM with public_id "${input.public_id}" not found`,
        });
      }

      return updated;
    }),

  delete: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'custom_llm.model.delete',
        target: inputFieldTarget('other', 'public_id'),
      },
    })
    .input(DeleteCustomLlmSchema)
    .mutation(async ({ input }) => {
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
