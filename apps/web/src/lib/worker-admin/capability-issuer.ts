import 'server-only';
import { SignJWT, importJWK, type JWK } from 'jose';
import { z } from 'zod';
import type { User } from '@kilocode/db/schema';
import {
  BROWSER_CAPABILITY_TTL_SECONDS,
  WORKER_ADMIN_ACTIONS,
  WORKER_ADMIN_CAPABILITY_ISSUER,
  WORKER_ADMIN_CAPABILITY_TYP,
  WORKER_ADMIN_CAPABILITY_VERSION,
  WorkerAdminTargetSchema,
  findWorkerAdminAction,
  workerAdminBindingDigest,
  workerAdminServiceTarget,
  type WorkerAdminAudience,
  type WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { isWorkerAdminCapabilityIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import {
  recordKiloAdminElevationForRequest,
  serviceTarget,
} from '@kilocode/web-shared/lib/admin/admin-access-log';

export class WorkerAdminCapabilityIssuanceError extends Error {
  constructor(
    public readonly status: 400 | 403 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'WorkerAdminCapabilityIssuanceError';
  }
}

export const AdminCapabilityRequestSchema = z
  .object({
    adminCapability: z
      .object({
        target: WorkerAdminTargetSchema,
        actions: z.array(z.string().min(1).max(200)).min(1).max(32).optional(),
      })
      .strict(),
  })
  .strict();

export type AdminCapabilityRequest = z.infer<typeof AdminCapabilityRequestSchema>;

export type IssuedWorkerAdminCapability = {
  capability: string;
  capabilityExpiresAt: string;
  jti: string;
  actions: string[];
};

type PrivateJwk = JWK & { kid?: string };

function parsePrivateJwk(): PrivateJwk {
  const configured = getEnvVariable('WORKER_ADMIN_CAPABILITY_PRIVATE_JWK');
  if (!configured) {
    throw new WorkerAdminCapabilityIssuanceError(
      503,
      'signing_key_unavailable',
      'Worker admin capability signing key is not configured'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new WorkerAdminCapabilityIssuanceError(
      503,
      'signing_key_invalid',
      'Worker admin capability signing key is invalid'
    );
  }
  const schema = z
    .object({ kty: z.literal('EC'), crv: z.literal('P-256'), kid: z.string().min(1) })
    .passthrough();
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new WorkerAdminCapabilityIssuanceError(
      503,
      'signing_key_invalid',
      'Worker admin capability signing key is invalid'
    );
  }
  return parsed as PrivateJwk;
}

function defaultActions(audience: WorkerAdminAudience, target: WorkerAdminTarget): string[] {
  const entries = WORKER_ADMIN_ACTIONS[audience];
  return Object.entries(entries)
    .filter(([, entry]) => entry.access === 'read' && entry.targetKind === target.kind)
    .map(([actionId]) => actionId)
    .sort();
}

function resolveActions(
  audience: WorkerAdminAudience,
  target: WorkerAdminTarget,
  requested: string[] | undefined
): string[] {
  const actions = requested ?? defaultActions(audience, target);
  if (actions.length === 0) {
    throw new WorkerAdminCapabilityIssuanceError(
      403,
      'no_actions_for_target',
      'No Worker admin actions are available for this target'
    );
  }
  for (const actionId of actions) {
    const entry = findWorkerAdminAction(audience, actionId);
    if (!entry || entry.targetKind !== target.kind) {
      throw new WorkerAdminCapabilityIssuanceError(
        403,
        'action_not_allowed',
        `Worker admin action is not allowed for this target: ${actionId}`
      );
    }
  }
  if (target.kind === 'service') {
    const expected = workerAdminServiceTarget(audience).id;
    if (target.id !== expected) {
      throw new WorkerAdminCapabilityIssuanceError(
        403,
        'service_target_mismatch',
        'Service capabilities are limited to the requesting service'
      );
    }
  }
  return [...new Set(actions)].sort();
}

export type IssueWorkerAdminCapabilityParams = {
  user: Pick<User, 'id' | 'api_token_pepper' | 'google_user_email' | 'is_admin' | 'is_super_admin'>;
  audience: WorkerAdminAudience;
  target: WorkerAdminTarget;
  actions?: string[];
  ttlSeconds?: number;
  now?: Date;
  headersList?: Headers;
};

/**
 * Mint a short-lived Worker admin capability for a session-authenticated
 * admin. This never widens authorization: the Worker still introspects the
 * capability and re-reads the user's role before granting anything.
 */
export async function issueWorkerAdminCapability(
  params: IssueWorkerAdminCapabilityParams
): Promise<IssuedWorkerAdminCapability> {
  if (!isWorkerAdminCapabilityIssuanceEnabled()) {
    throw new WorkerAdminCapabilityIssuanceError(
      403,
      'capability_issuance_disabled',
      'Worker admin capability issuance is disabled'
    );
  }
  const key = parsePrivateJwk();
  const actions = resolveActions(params.audience, params.target, params.actions);
  const now = params.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const requestedTtl = params.ttlSeconds ?? BROWSER_CAPABILITY_TTL_SECONDS;
  const ttl = Math.max(1, Math.min(requestedTtl, BROWSER_CAPABILITY_TTL_SECONDS));
  const jti = crypto.randomUUID();
  const pepper = await workerAdminBindingDigest(params.user.api_token_pepper);
  const wsp = await workerAdminBindingDigest('');

  const capability = await new SignJWT({
    iss: WORKER_ADMIN_CAPABILITY_ISSUER,
    sub: params.user.id,
    aud: params.audience,
    env: process.env.NODE_ENV,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttl,
    jti,
    cap: { v: WORKER_ADMIN_CAPABILITY_VERSION, actions, targets: [params.target] },
    bnd: { pep: pepper, wsp },
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: WORKER_ADMIN_CAPABILITY_TYP,
      kid: key.kid,
    })
    .sign(await importJWK(key, 'ES256'));

  await recordKiloAdminElevationForRequest({
    user: params.user,
    reason: 'worker_capability_mint',
    target: serviceTarget(params.audience === 'gastown-admin' ? 'gastown' : 'wasteland'),
    surface: 'rest',
    headersList: params.headersList,
    issuanceId: jti,
  });

  return {
    capability,
    capabilityExpiresAt: new Date((issuedAt + ttl) * 1000).toISOString(),
    jti,
    actions,
  };
}
