import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { byok_api_keys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { encryptApiKey } from '@/lib/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import {
  CreateBYOKKeyInputSchema,
  UpdateBYOKKeyInputSchema,
  DeleteBYOKKeyInputSchema,
  SetBYOKKeyEnabledInputSchema,
  ListBYOKKeysInputSchema,
  BYOKApiKeyResponseSchema,
  type BYOKApiKeyResponse,
} from '@/lib/byok/types';

export const byokRouter = createTRPCRouter({
  list: baseProcedure
    .input(ListBYOKKeysInputSchema)
    .output(z.array(BYOKApiKeyResponseSchema))
    .query(async ({ input, ctx }): Promise<BYOKApiKeyResponse[]> => {
      const { organizationId } = input;

      // If organizationId provided, verify membership; otherwise use user's own keys
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId);
      }

      const keys = await db
        .select({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          is_enabled: byok_api_keys.is_enabled,
        })
        .from(byok_api_keys)
        .where(
          organizationId
            ? eq(byok_api_keys.organization_id, organizationId)
            : eq(byok_api_keys.kilo_user_id, ctx.user.id)
        );

      // Map provider_id to provider_name (will be enhanced in UI with actual provider names)
      return keys.map(key => ({
        ...key,
        provider_name: key.provider_id,
      }));
    }),

  create: baseProcedure
    .input(CreateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, provider_id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      if (!BYOK_ENCRYPTION_KEY) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'BYOK encryption is not configured',
        });
      }

      // Encrypt the API key
      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);

      // Insert into database - either org-owned or user-owned
      const [newKey] = await db
        .insert(byok_api_keys)
        .values({
          organization_id: organizationId ?? null,
          kilo_user_id: organizationId ? null : ctx.user.id,
          provider_id,
          encrypted_api_key: encrypted,
          created_by: ctx.user.id,
        })
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          is_enabled: byok_api_keys.is_enabled,
        });

      // Create audit log only for organization keys
      if (organizationId) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Added BYOK key for provider: ${provider_id}`,
          organization_id: organizationId,
        });
      }

      return {
        ...newKey,
        provider_name: provider_id,
      };
    }),

  update: baseProcedure
    .input(UpdateBYOKKeyInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, api_key } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      if (!BYOK_ENCRYPTION_KEY) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'BYOK encryption is not configured',
        });
      }

      // Verify key exists and belongs to the organization or user
      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      // Verify ownership: org key must match org, user key must match user
      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      // Encrypt the new API key
      const encrypted = encryptApiKey(api_key, BYOK_ENCRYPTION_KEY);

      // Update in database
      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          encrypted_api_key: encrypted,
        })
        .where(eq(byok_api_keys.id, id))
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          is_enabled: byok_api_keys.is_enabled,
        });

      // Create audit log only for organization keys
      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Updated BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return {
        ...updatedKey,
        provider_name: updatedKey.provider_id,
      };
    }),

  setEnabled: baseProcedure
    .input(SetBYOKKeyEnabledInputSchema)
    .output(BYOKApiKeyResponseSchema)
    .mutation(async ({ input, ctx }): Promise<BYOKApiKeyResponse> => {
      const { organizationId, id, is_enabled } = input;

      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      const [updatedKey] = await db
        .update(byok_api_keys)
        .set({
          is_enabled,
        })
        .where(eq(byok_api_keys.id, id))
        .returning({
          id: byok_api_keys.id,
          provider_id: byok_api_keys.provider_id,
          created_at: byok_api_keys.created_at,
          updated_at: byok_api_keys.updated_at,
          created_by: byok_api_keys.created_by,
          is_enabled: byok_api_keys.is_enabled,
        });

      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `${is_enabled ? 'Enabled' : 'Disabled'} BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return {
        ...updatedKey,
        provider_name: updatedKey.provider_id,
      };
    }),

  delete: baseProcedure
    .input(DeleteBYOKKeyInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { organizationId, id } = input;

      // If organizationId provided, verify owner/billing access
      if (organizationId) {
        await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);
      }

      // Verify key exists and belongs to the organization or user
      const [existingKey] = await db
        .select({
          organization_id: byok_api_keys.organization_id,
          kilo_user_id: byok_api_keys.kilo_user_id,
          provider_id: byok_api_keys.provider_id,
        })
        .from(byok_api_keys)
        .where(eq(byok_api_keys.id, id));

      if (!existingKey) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'BYOK key not found',
        });
      }

      // Verify ownership: org key must match org, user key must match user
      if (organizationId) {
        if (existingKey.organization_id !== organizationId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      } else {
        if (existingKey.kilo_user_id !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'BYOK key not found',
          });
        }
      }

      // Delete from database
      await db.delete(byok_api_keys).where(eq(byok_api_keys.id, id));

      // Create audit log only for organization keys
      if (existingKey.organization_id) {
        await createAuditLog({
          action: 'organization.settings.change',
          actor_email: ctx.user.google_user_email,
          actor_id: ctx.user.id,
          actor_name: ctx.user.google_user_name,
          message: `Deleted BYOK key for provider: ${existingKey.provider_id}`,
          organization_id: existingKey.organization_id,
        });
      }

      return { success: true };
    }),
});
