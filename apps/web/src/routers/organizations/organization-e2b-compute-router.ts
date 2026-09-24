import 'server-only';

import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { organization_e2b_compute_credentials } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getE2BComputeEnrollment } from '@/lib/cloud-agent-next/cloud-agent-client';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import {
  E2BApiError,
  E2BComputeStatusSchema,
  toE2BComputeStatus,
  validateE2BApiKey,
} from '@/lib/e2b-client';
import { createTRPCRouter } from '@/lib/trpc/init';
import {
  organizationAdminProcedure,
  OrganizationIdInputSchema,
} from '@/routers/organizations/utils';

const E2BOrganizationIdInputSchema = OrganizationIdInputSchema.extend({
  organizationId: z.uuid().transform(value => value.toLowerCase()),
});

async function loadEnrollment(organizationId: string): Promise<{ enrolled: boolean }> {
  try {
    return await getE2BComputeEnrollment({ organizationId });
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'E2B compute enrollment could not be verified. Try again later.',
    });
  }
}

function connectionConflict() {
  return new TRPCError({
    code: 'CONFLICT',
    message: 'E2B compute is already configured. Remove it before adding new credentials.',
  });
}

function encryptApiKey(apiKey: string, organizationId: string, credentialId: string) {
  const scheme = 'byoc-e2b-credential-rsa-aes-256-gcm';
  try {
    return parseKeyedEnvelope(
      encryptKeyedEnvelope(
        apiKey,
        scheme,
        {
          keyId: 'agent-env-vars-v1',
          publicKeyPem: Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64'),
        },
        `byoc-e2b-credential:v1:${organizationId}:${credentialId}`
      ),
      scheme
    );
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'E2B credential storage is not available. Try again later.',
    });
  }
}

export const organizationE2BComputeRouter = createTRPCRouter({
  getEnrollment: organizationAdminProcedure
    .input(E2BOrganizationIdInputSchema)
    .output(z.object({ enrolled: z.boolean() }))
    .query(({ input }) => loadEnrollment(input.organizationId)),

  getStatus: organizationAdminProcedure
    .input(E2BOrganizationIdInputSchema)
    .output(E2BComputeStatusSchema.nullable())
    .query(async ({ input }) => {
      const row = await db.query.organization_e2b_compute_credentials.findFirst({
        where: eq(organization_e2b_compute_credentials.organization_id, input.organizationId),
        columns: { api_key_encrypted: false },
      });
      return row ? toE2BComputeStatus(row) : null;
    }),

  add: organizationAdminProcedure
    .input(
      E2BOrganizationIdInputSchema.extend({
        apiKey: z.string().trim().min(1).max(4096),
        acknowledgeDirectTokenAccess: z.literal(true),
        consentVersion: z.literal('e2b-direct-v1'),
      })
    )
    .output(E2BComputeStatusSchema)
    .mutation(async ({ input }) => {
      const { enrolled } = await loadEnrollment(input.organizationId);
      if (!enrolled) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Customer-paid E2B compute is not available for this organization.',
        });
      }

      const existing = await db.query.organization_e2b_compute_credentials.findFirst({
        where: eq(organization_e2b_compute_credentials.organization_id, input.organizationId),
        columns: { id: true },
      });
      if (existing) throw connectionConflict();

      const credentialId = crypto.randomUUID();
      const apiKeyEncrypted = encryptApiKey(input.apiKey, input.organizationId, credentialId);
      await validateE2BApiKey(input.apiKey).catch((error: unknown) => {
        const failure =
          error instanceof E2BApiError ? error : new E2BApiError('SERVICE_UNAVAILABLE');
        throw new TRPCError({ code: failure.code, message: failure.message });
      });

      const now = new Date().toISOString();
      const [row] = await db
        .insert(organization_e2b_compute_credentials)
        .values({
          id: credentialId,
          organization_id: input.organizationId,
          api_key_encrypted: apiKeyEncrypted,
          consent_version: input.consentVersion,
          consented_at: now,
          validated_at: now,
        })
        .onConflictDoNothing({ target: organization_e2b_compute_credentials.organization_id })
        .returning({
          id: organization_e2b_compute_credentials.id,
          organization_id: organization_e2b_compute_credentials.organization_id,
          consent_version: organization_e2b_compute_credentials.consent_version,
          consented_at: organization_e2b_compute_credentials.consented_at,
          validated_at: organization_e2b_compute_credentials.validated_at,
          created_at: organization_e2b_compute_credentials.created_at,
        })
        .catch(() => {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'E2B credentials could not be stored. Try again later.',
          });
        });
      if (!row) throw connectionConflict();
      return toE2BComputeStatus(row);
    }),

  remove: organizationAdminProcedure
    .input(
      E2BOrganizationIdInputSchema.extend({
        credentialId: z.uuid(),
        acknowledgeRemoval: z.literal(true),
      })
    )
    .mutation(async ({ input }) => {
      await db
        .delete(organization_e2b_compute_credentials)
        .where(
          and(
            eq(organization_e2b_compute_credentials.id, input.credentialId),
            eq(organization_e2b_compute_credentials.organization_id, input.organizationId)
          )
        );
      return { success: true } as const;
    }),
});
