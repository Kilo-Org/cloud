import { timingSafeEqual } from '@kilocode/encryption';
import { withTimeout } from '@kilocode/worker-utils';
import {
  AWS_EGRESS_POLICY_REFRESH_MS,
  AWS_EGRESS_POLICY_TTL_MS,
} from '@kilocode/worker-utils/aws-egress';
import type { AwsEgressClaims } from '@kilocode/worker-utils/aws-egress';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { AwsEcsOperation } from '../sandbox-control/aws-ecs-operation.js';
import { encodeAwsEcsProviderRef } from '../sandbox-control/aws-ecs-operation.js';
import { resolveAwsEcsByocConfiguration } from '../byoc/aws-credential-resolver.js';
import { resolveSecret } from '../auth.js';
import { createAwsRoleSessionCache } from '../byoc/aws-runtime-access.js';
import { awsAccountAccess } from '../byoc/aws-account-access.js';
import { readPinnedAwsProxyDeployment } from '../byoc/aws-proxy.js';
import type { AwsProxyMetadata } from '../byoc/aws-proxy.js';
import type { ByocSource } from '../byoc/owner.js';
import { sandboxCredentialMatchesHash } from '../sandbox-control/credential.js';
import {
  type ScopedScmGrant,
  type ScopedScmAdmissionContext,
  type ScopedScmAdmissionDependencies,
} from '../scm-broker/scoped-admission.js';
import type { Env } from '../types.js';
import { AwsEgressAdmissionError as AdmissionFailure } from './aws-egress-error.js';

export type AwsEgressProof = { credential: string; identity: string };
export type AwsScopedEgressContext<G extends ScopedScmGrant> = ScopedScmAdmissionContext<G> & {
  byoc?: ByocSource;
  operation: AwsEcsOperation | null;
  credentialHash?: string;
  allowlist?: readonly string[];
  audit: boolean;
};
export type AwsEgressIdentityClaims = Pick<
  AwsEgressClaims,
  'sandboxId' | 'allocationId' | 'credential' | 'generation' | 'stackId' | 'exp'
>;
type IssuedContext<C> = C & {
  byoc: ByocSource;
  credentialHash: string;
  operation: AwsEcsOperation & { deadlineAt: number };
};
function issued<G extends ScopedScmGrant, C extends AwsScopedEgressContext<G>>(
  context: C,
  now: number
): context is IssuedContext<C> {
  const operation = context.operation;
  return Boolean(
    context.available &&
    context.provider === operation?.ref.provider &&
    context.containmentEnabled &&
    context.ownerId &&
    context.byoc &&
    context.credentialHash &&
    operation?.config.proxy &&
    operation.ref.sandboxId === context.sandboxId &&
    (context.byoc.userId === undefined || context.byoc.userId === context.ownerId) &&
    context.allocation.active &&
    context.allocation.allocationId === operation.ref.intentId &&
    context.allocation.providerRef === encodeAwsEcsProviderRef(operation.ref) &&
    (operation.phase === 'launching' || operation.phase === 'running') &&
    operation.request &&
    operation.deadlineAt !== undefined &&
    operation.deadlineAt > now
  );
}
function binding<G extends ScopedScmGrant>(context: AwsScopedEgressContext<G>) {
  return JSON.stringify([
    context.sandboxId,
    context.ownerId,
    context.provider,
    context.containmentEnabled,
    context.allocation.allocationId,
    context.allocation.providerRef,
    context.byoc,
    context.credentialHash,
    context.operation?.config,
    context.identityBinding,
  ]);
}

/** Owns AWS identity only. Shared SCM admission remains the owner of repository and credential rules. */
export function createAwsEgressIdentity<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
>(deps: {
  env: Env;
  serial: ScopedScmAdmissionDependencies<G, C>['serial'];
  readContext: () => Promise<C>;
  verifyCredential(
    token: string,
    secret: string,
    context: C,
    now: number
  ): AwsEgressIdentityClaims | null;
  resolveConfiguration?: (source: ByocSource) => Promise<AwsEcsByocConfiguration>;
  readMetadata?: (configuration: AwsEcsByocConfiguration) => Promise<AwsProxyMetadata>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const access = createAwsRoleSessionCache((configuration: AwsEcsByocConfiguration) =>
    awsAccountAccess(deps.env, configuration)
  );
  // One admission owner retains at most one deployment cache entry. Current owner
  // authorization is never cached, and failed reads cannot use stale metadata.
  let deployment: { key: string; validUntil: number; value: Promise<AwsProxyMetadata> } | undefined;
  async function readDeployment(config: AwsEcsByocConfiguration, source: ByocSource) {
    const key = JSON.stringify([source, config]);
    const startedAt = now();
    if (deployment?.key === key && startedAt < deployment.validUntil) return deployment.value;
    const entry = {
      key,
      validUntil: startedAt + Math.min(AWS_EGRESS_POLICY_REFRESH_MS, AWS_EGRESS_POLICY_TTL_MS),
      value: readPinnedAwsProxyDeployment(config, async signal =>
        deps.readMetadata
          ? deps.readMetadata(config)
          : (await access(config)).readProxyMetadata(signal)
      ),
    };
    deployment = entry;
    try {
      const metadata = await entry.value;
      entry.validUntil = Math.min(entry.validUntil, Date.parse(metadata.deployment.expiresAt));
      return metadata;
    } catch (error) {
      if (deployment === entry) deployment = undefined;
      throw error;
    }
  }

  type BoundContext = C & { organizationId: string | undefined; identityBinding: string };
  const readContext = async (): Promise<BoundContext> => {
    const context = await deps.readContext();
    return {
      ...context,
      organizationId: context.byoc?.organizationId,
      identityBinding: binding(context),
    };
  };
  async function authenticate(context: C, proof: AwsEgressProof) {
    if (!issued(context, now())) throw new AdmissionFailure(403, 'allocation_unavailable');
    if (
      typeof proof?.credential !== 'string' ||
      typeof proof.identity !== 'string' ||
      proof.credential.length > 4096 ||
      !/^[a-f0-9]{64}$/.test(proof.identity)
    )
      throw new AdmissionFailure(401, 'invalid_identity');
    const secret = await withTimeout(
      deps.signingSecret ? deps.signingSecret() : resolveSecret(deps.env.NEXTAUTH_SECRET),
      1_000,
      'AWS egress signer unavailable'
    );
    const claims = secret ? deps.verifyCredential(proof.credential, secret, context, now()) : null;
    const config = context.operation.config;
    if (
      !claims ||
      claims.sandboxId !== context.sandboxId ||
      claims.allocationId !== context.allocation.allocationId ||
      claims.stackId !== config.stackId ||
      claims.generation !== config.proxy.generation ||
      !(await sandboxCredentialMatchesHash(claims.credential, context.credentialHash))
    )
      throw new AdmissionFailure(401, 'invalid_identity');
    // A cached STS session never replaces the current owner/connection authorization read.
    const current = await (
      deps.resolveConfiguration ?? resolveAwsEcsByocConfiguration.bind(null, deps.env)
    )(context.byoc);
    if (JSON.stringify(current) !== JSON.stringify(config))
      throw new AdmissionFailure(403, 'connection_changed');
    const metadata = await readDeployment(config, context.byoc);
    if (!timingSafeEqual(proof.identity, metadata.identity.secret))
      throw new AdmissionFailure(401, 'invalid_identity');
    const expiresAt = Math.min(
      claims.exp * 1000,
      Date.parse(metadata.deployment.expiresAt),
      context.operation.deadlineAt
    );
    if (expiresAt <= now()) throw new AdmissionFailure(403, 'identity_expired');
    return { claims, expiresAt, initialBinding: binding(context) };
  }
  async function current(identity: {
    claims: AwsEgressIdentityClaims;
    expiresAt: number;
    initialBinding: string;
  }) {
    const context = await readContext();
    if (
      !issued(context, now()) ||
      binding(context) !== identity.initialBinding ||
      identity.expiresAt <= now()
    )
      throw new AdmissionFailure(403, 'allocation_unavailable');
    return context;
  }
  async function accepted<T>(
    proof: AwsEgressProof,
    operation: (
      context: IssuedContext<BoundContext>,
      identity: Awaited<ReturnType<typeof authenticate>>
    ) => Promise<T>
  ) {
    const initial = await deps.serial(readContext);
    const identity = await authenticate(initial, proof);
    return withCurrent(identity, context => operation(context, identity));
  }
  function withCurrent<T>(
    identity: Awaited<ReturnType<typeof authenticate>>,
    action: (context: IssuedContext<BoundContext>) => T | Promise<T>
  ) {
    return deps.serial(async () => action(await current(identity)));
  }
  return { authenticate, accepted, withCurrent, readContext, serial: deps.serial, now };
}
export type AwsEgressIdentity<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
> = ReturnType<typeof createAwsEgressIdentity<G, C>>;
