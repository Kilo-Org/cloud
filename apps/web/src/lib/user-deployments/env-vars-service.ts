import 'server-only';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Deployment } from '@kilocode/db/schema';
import { deployment_env_vars, deployments } from '@kilocode/db/schema';
import { sql, eq, and } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@/lib/encryption';
import {
  type PlaintextEnvVar,
  type EncryptedEnvVar,
  type EnvVarResponse,
  markAsEncrypted,
} from '@/lib/user-deployments/env-vars-validation';
import type { Owner } from '@/lib/user-deployments/router-types';
import { USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY } from '@/lib/config.server';

/**
 * Encrypts plaintext env vars, producing encrypted env vars.
 * Non-secret variables are returned as-is.
 * The builder will decrypt secrets using the private key.
 */
export function encryptEnvVars(envVars: PlaintextEnvVar[]): EncryptedEnvVar[] {
  if (envVars.length === 0) {
    return [];
  }

  const publicKey = Buffer.from(USER_DEPLOYMENTS_ENV_VARS_PUBLIC_KEY, 'base64');

  return envVars.map(v => {
    if (!v.isSecret) {
      // Non-secrets can be marked as encrypted (value remains plaintext)
      return markAsEncrypted({ key: v.key, value: v.value, isSecret: v.isSecret });
    }

    const envelope = encryptWithPublicKey(v.value, publicKey);
    return markAsEncrypted({
      key: v.key,
      value: JSON.stringify(envelope),
      isSecret: v.isSecret,
    });
  });
}

/**
 * Verify that a deployment exists and is owned by the specified owner
 */
async function verifyDeploymentOwnership(deploymentId: string, owner: Owner): Promise<Deployment> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), ownershipCondition))
    .limit(1);

  if (!deployment) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Deployment not found',
    });
  }

  return deployment;
}

/**
 * Set or update an environment variable for a deployment.
 * Accepts already-encrypted env vars; stores the value directly.
 * When tx is provided, uses the transaction instead of db.
 */
export async function setEnvVar(
  deployment: string | Deployment,
  envVar: EncryptedEnvVar,
  owner: Owner,
  tx?: DrizzleTransaction
): Promise<void> {
  if (typeof deployment === 'string') {
    deployment = await verifyDeploymentOwnership(deployment, owner);
  }

  // Store the value directly - caller is responsible for encryption
  const dbInstance = tx ?? db;

  await dbInstance
    .insert(deployment_env_vars)
    .values({
      deployment_id: deployment.id,
      key: envVar.key,
      value: envVar.value,
      is_secret: envVar.isSecret,
    })
    .onConflictDoUpdate({
      target: [deployment_env_vars.deployment_id, deployment_env_vars.key],
      set: {
        value: envVar.value,
        is_secret: envVar.isSecret,
        updated_at: new Date().toISOString(),
      },
    });
}

/**
 * Delete an environment variable from a deployment
 */
export async function deleteEnvVar(deploymentId: string, key: string, owner: Owner): Promise<void> {
  await verifyDeploymentOwnership(deploymentId, owner);

  const result = await db
    .delete(deployment_env_vars)
    .where(
      and(eq(deployment_env_vars.deployment_id, deploymentId), eq(deployment_env_vars.key, key))
    )
    .returning();

  if (result.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Environment variable not found',
    });
  }
}

/**
 * List all environment variables for a deployment
 * Returns masked values for secrets
 */
export async function listEnvVars(deploymentId: string, owner: Owner): Promise<EnvVarResponse[]> {
  await verifyDeploymentOwnership(deploymentId, owner);

  const envVars = await db
    .select({
      key: deployment_env_vars.key,
      value: sql<string>`
        CASE
          WHEN ${deployment_env_vars.is_secret} = true
          THEN '***'
          ELSE ${deployment_env_vars.value}
        END
      `.as('value'),
      isSecret: deployment_env_vars.is_secret,
      createdAt: deployment_env_vars.created_at,
      updatedAt: deployment_env_vars.updated_at,
    })
    .from(deployment_env_vars)
    .where(eq(deployment_env_vars.deployment_id, deploymentId));

  return envVars;
}

/**
 * Rename an environment variable atomically
 */
export async function renameEnvVar(
  deploymentId: string,
  oldKey: string,
  newKey: string,
  owner: Owner
): Promise<void> {
  await verifyDeploymentOwnership(deploymentId, owner);

  if (oldKey === newKey) {
    return;
  }

  const existing = await db
    .select()
    .from(deployment_env_vars)
    .where(
      and(eq(deployment_env_vars.deployment_id, deploymentId), eq(deployment_env_vars.key, oldKey))
    )
    .limit(1);

  if (existing.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Environment variable not found',
    });
  }

  await db.transaction(async tx => {
    await tx
      .delete(deployment_env_vars)
      .where(
        and(
          eq(deployment_env_vars.deployment_id, deploymentId),
          eq(deployment_env_vars.key, oldKey)
        )
      );

    await tx.insert(deployment_env_vars).values({
      deployment_id: deploymentId,
      key: newKey,
      value: existing[0].value,
      is_secret: existing[0].is_secret,
    });
  });
}

/**
 * Get all environment variables for a deployment.
 * Returns encrypted env vars - secrets have encrypted values.
 * Internal function used by deployment service - no ownership check.
 */
export async function getEnvVarsForDeployment(deploymentId: string): Promise<EncryptedEnvVar[]> {
  const envVars = await db
    .select()
    .from(deployment_env_vars)
    .where(eq(deployment_env_vars.deployment_id, deploymentId));

  return envVars.map(v =>
    markAsEncrypted({
      key: v.key,
      value: v.value,
      isSecret: v.is_secret,
    })
  );
}
