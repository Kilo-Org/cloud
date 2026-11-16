import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { byoc_connections, type ByocConnection } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { AGENT_ENV_VARS_PUBLIC_KEY } from '@kilocode/web-shared/lib/config.server';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import type { AwsSetupOwner, AwsSetupProvider } from '@kilocode/worker-utils/aws-onboarding';
import {
  awsProviderSetupEnvelope,
  awsProviderConfigurationEnvelope,
  awsProviderSetupIntentSchemaFor,
  awsProviderConfigurationSchemaFor,
} from '@kilocode/worker-utils/aws-ecs-onboarding';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import {
  awsEnrollmentSchema,
  awsInstructionsSchema,
  awsPublicConfigurationSchema,
  awsVerificationSchema,
} from '@kilocode/worker-utils/aws-onboarding-api';
import { awsSetupRequest } from '@/lib/cloud-agent-next/aws-setup-client';

const pendingMetadata = z
  .object({
    accountId: z.string().regex(/^\d{12}$/),
    stackName: z.string().regex(/^kilo-[a-f0-9]{32}$/),
    templateVersion: z.number().int().positive(),
  })
  .strict();

function ownerCondition(owner: AwsSetupOwner, provider: AwsSetupProvider) {
  return and(
    eq(byoc_connections.provider, provider),
    owner.organizationId !== undefined
      ? eq(byoc_connections.organization_id, owner.organizationId)
      : eq(byoc_connections.user_id, owner.userId)
  );
}
async function find(owner: AwsSetupOwner, provider: AwsSetupProvider) {
  return db.query.byoc_connections.findFirst({ where: ownerCondition(owner, provider) });
}
function binding(owner: AwsSetupOwner, row: ByocConnection) {
  return { owner, credentialId: row.id, generation: row.build_generation };
}
function unchangedDraft(owner: AwsSetupOwner, row: ByocConnection, provider: AwsSetupProvider) {
  return and(
    ownerCondition(owner, provider),
    eq(byoc_connections.id, row.id),
    eq(byoc_connections.build_generation, row.build_generation),
    inArray(byoc_connections.setup_status, ['pending', 'failed'])
  );
}
function changed(): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: 'AWS setup changed. Reload the page and try again.',
  });
}
function seal(value: unknown, scheme: string, aad: string) {
  if (!AGENT_ENV_VARS_PUBLIC_KEY) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'AWS setup is unavailable. Try again later.',
    });
  }
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      JSON.stringify(value),
      scheme,
      {
        keyId: AWS_BYOC_ENVELOPE_KEY_ID,
        publicKeyPem: Buffer.from(AGENT_ENV_VARS_PUBLIC_KEY, 'base64'),
      },
      aad
    ),
    scheme
  );
}

/** Explicit projection: ciphertext, ExternalId and proxy credentials never enter a browser response. */
export function awsStatusFromRow(row: ByocConnection, provider: AwsSetupProvider) {
  if (row.provider !== provider) throw new Error('Expected AWS connection');
  if (row.setup_status === 'ready') {
    const metadata = awsPublicConfigurationSchema.parse(row.config);
    const verified = row.runtime.last_verified_at ?? row.setup_completed_at;
    if (typeof verified !== 'string') throw new Error('AWS verification date is missing');
    return {
      state: 'ready' as const,
      ...metadata,
      lastVerifiedAt: new Date(verified).toISOString(),
    };
  }
  return {
    state: 'pending' as const,
    generation: row.build_generation,
    ...pendingMetadata.parse(row.config),
  };
}
export async function getAwsComputeStatus(owner: AwsSetupOwner, provider: AwsSetupProvider) {
  const row = await find(owner, provider);
  return row ? awsStatusFromRow(row, provider) : null;
}
export function getAwsComputeEnrollment(owner: AwsSetupOwner, provider: AwsSetupProvider) {
  return awsSetupRequest({ action: 'enrollment', owner, provider }, awsEnrollmentSchema);
}

export async function prepareAwsCompute(
  owner: AwsSetupOwner,
  accountId: string,
  provider: AwsSetupProvider
) {
  let row = await find(owner, provider);
  if (!row) {
    const draft = { owner, credentialId: crypto.randomUUID(), generation: crypto.randomUUID() };
    const intent = await awsSetupRequest(
      { action: 'prepare', ...draft, accountId, provider },
      awsProviderSetupIntentSchemaFor(provider)
    );
    const purpose = awsProviderSetupEnvelope(provider, draft);
    const now = new Date().toISOString();
    await db
      .insert(byoc_connections)
      .values({
        id: draft.credentialId,
        provider,
        organization_id: owner.organizationId ?? null,
        user_id: owner.userId ?? null,
        build_generation: draft.generation,
        credentials_encrypted: seal(intent, purpose.scheme, purpose.aad),
        config: {
          accountId: intent.accountId,
          stackName: intent.stackName,
          templateVersion: intent.release.templateVersion,
        },
        setup_status: 'pending',
        setup_started_at: now,
      })
      .onConflictDoNothing();
    // A concurrent request can win the unique owner/provider key. Always use the persisted winner.
    row = await find(owner, provider);
  }
  if (!row) changed();
  const status = awsStatusFromRow(row, provider);
  if (status.state === 'ready') changed();
  if (status.accountId !== accountId) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'AWS setup already uses another account. Discard the draft before changing accounts.',
    });
  }
  return status;
}
export async function getAwsComputeInstructions(owner: AwsSetupOwner, provider: AwsSetupProvider) {
  const row = await find(owner, provider);
  if (!row || row.setup_status === 'ready') changed();
  const instructions = await awsSetupRequest(
    {
      action: 'instructions',
      ...binding(owner, row),
      envelope: row.credentials_encrypted,
      provider,
    },
    awsInstructionsSchema
  );
  const current = await find(owner, provider);
  if (
    !current ||
    current.id !== row.id ||
    current.build_generation !== row.build_generation ||
    current.setup_status === 'ready'
  )
    changed();
  return instructions;
}
export async function validateAwsCompute(
  owner: AwsSetupOwner,
  roleArn: string,
  provider: AwsSetupProvider
) {
  const row = await find(owner, provider);
  if (!row) changed();
  const input = { ...binding(owner, row), envelope: row.credentials_encrypted, roleArn, provider };
  const now = () => new Date().toISOString();
  if (row.setup_status === 'ready') {
    await awsSetupRequest({ action: 'revalidate', ...input }, awsVerificationSchema);
    const updated = await db
      .update(byoc_connections)
      .set({
        runtime: sql`${byoc_connections.runtime} || ${JSON.stringify({ last_verified_at: now() })}::jsonb`,
      })
      .where(
        and(
          ownerCondition(owner, provider),
          eq(byoc_connections.id, row.id),
          eq(byoc_connections.build_generation, row.build_generation),
          eq(byoc_connections.setup_status, 'ready')
        )
      )
      .returning();
    if (!updated[0]) changed();
    return awsStatusFromRow(updated[0], provider);
  }
  const configuration = await awsSetupRequest(
    { action: 'validate', ...input },
    awsProviderConfigurationSchemaFor(provider)
  );
  const purpose = awsProviderConfigurationEnvelope(provider, owner, row.id);
  const verifiedAt = now();
  const updated = await db
    .update(byoc_connections)
    .set({
      credentials_encrypted: seal(configuration, purpose.scheme, purpose.aad),
      config: {
        accountId: configuration.roleArn.split(':')[4],
        roleArn: configuration.roleArn,
        stackId: configuration.stackId,
        region: configuration.region,
        templateVersion: configuration.templateVersion,
        proxyProtocolVersion: configuration.proxyProtocolVersion,
      },
      setup_status: 'ready',
      setup_completed_at: verifiedAt,
      setup_error: null,
      runtime: { last_verified_at: verifiedAt },
    })
    .where(unchangedDraft(owner, row, provider))
    .returning();
  if (!updated[0]) changed();
  return awsStatusFromRow(updated[0], provider);
}

/** This removes only an unfinished local draft. It never deletes customer AWS resources. */
export async function discardAwsComputeDraft(
  owner: AwsSetupOwner,
  generation: string,
  provider: AwsSetupProvider
) {
  const removed = await db
    .delete(byoc_connections)
    .where(
      and(
        ownerCondition(owner, provider),
        eq(byoc_connections.build_generation, generation),
        inArray(byoc_connections.setup_status, ['pending', 'failed'])
      )
    )
    .returning({ id: byoc_connections.id });
  if (!removed[0]) changed();
  return { discarded: true };
}
