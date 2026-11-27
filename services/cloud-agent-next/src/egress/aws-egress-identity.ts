import { withTimeout } from '@kilocode/worker-utils';
import type { AwsEc2EgressClaims } from '@kilocode/worker-utils/aws-egress';
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import { awsEc2Ref, type AwsEc2Workspace } from '../sandbox-control/aws-ec2-lifecycle.js';
import { verifyAwsEc2EgressCredential } from './aws-credential.js';
import { resolveAwsEc2ByocConfiguration } from '../byoc/aws-credential-resolver.js';
import { resolveSecret } from '../auth.js';
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
  ec2?: AwsEc2Workspace | null;
  ec2Build?: AwsEc2EgressClaims['build'];
  allowlist?: readonly string[];
  audit: boolean;
};
function issuedEc2<G extends ScopedScmGrant, C extends AwsScopedEgressContext<G>>(
  context: C,
  now: number
): context is C & {
  byoc: ByocSource;
  ec2: AwsEc2Workspace & {
    instanceId: string;
    allocation: { egress: { expiresAt: number; identityHash: string } };
  };
} {
  const workspace = context.ec2;
  return Boolean(
    context.available &&
    context.provider === 'aws-ec2' &&
    context.containmentEnabled &&
    context.ownerId &&
    context.byoc &&
    (context.byoc.userId === undefined || context.byoc.userId === context.ownerId) &&
    context.allocation.active &&
    workspace &&
    workspace.instanceId &&
    workspace.allocation.egress &&
    workspace.allocation.egress.expiresAt > now &&
    (workspace.phase === 'starting' || workspace.phase === 'active') &&
    context.allocation.allocationId === workspace.allocation.id &&
    context.allocation.providerRef === awsEc2Ref(workspace)
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
    context.ec2?.config,
    context.ec2?.allocation.egress,
    context.ec2?.instanceId,
    context.ec2Build,
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
  resolveEc2Configuration?: (source: ByocSource) => Promise<AwsEc2ByocConfiguration>;
  signingSecret?: () => Promise<string | undefined>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  type BoundContext = C & { organizationId: string | undefined; identityBinding: string };
  const readContext = async (): Promise<BoundContext> => {
    const context = await deps.readContext();
    return {
      ...context,
      organizationId: context.byoc?.organizationId,
      identityBinding: binding(context),
    };
  };
  type Authenticated = {
    claims: AwsEc2EgressClaims;
    expiresAt: number;
    initialBinding: string;
  };
  async function authenticate(context: C, proof: AwsEgressProof): Promise<Authenticated> {
    if (!issuedEc2(context, now())) throw new AdmissionFailure(403, 'allocation_unavailable');
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
    const workspace = context.ec2;
    const claims = secret ? verifyAwsEc2EgressCredential(proof.credential, secret, now()) : null;
    if (
      !claims ||
      claims.sandboxId !== context.sandboxId ||
      claims.allocationId !== workspace.allocation.id ||
      claims.instanceId !== workspace.instanceId ||
      claims.generation !== workspace.generation ||
      claims.stackId !== workspace.config.stackId ||
      claims.build?.environmentId !== context.ec2Build?.environmentId ||
      claims.build?.buildId !== context.ec2Build?.buildId ||
      claims.build?.actorUserId !== context.ec2Build?.actorUserId ||
      claims.build?.credentialId !== context.ec2Build?.credentialId ||
      !(await sandboxCredentialMatchesHash(
        proof.identity,
        workspace.allocation.egress.identityHash
      ))
    )
      throw new AdmissionFailure(401, 'invalid_identity');
    const configuration = await (
      deps.resolveEc2Configuration ?? resolveAwsEc2ByocConfiguration.bind(null, deps.env)
    )(context.byoc);
    if (JSON.stringify(configuration) !== JSON.stringify(workspace.config))
      throw new AdmissionFailure(403, 'connection_changed');
    const expiresAt = Math.min(claims.exp * 1000, workspace.allocation.egress.expiresAt);
    if (expiresAt <= now()) throw new AdmissionFailure(403, 'identity_expired');
    return { claims, expiresAt, initialBinding: binding(context) };
  }
  async function current(identity: Authenticated) {
    const context = await readContext();
    if (
      !issuedEc2(context, now()) ||
      binding(context) !== identity.initialBinding ||
      identity.expiresAt <= now()
    )
      throw new AdmissionFailure(403, 'allocation_unavailable');
    return context;
  }
  async function accepted<T>(
    proof: AwsEgressProof,
    operation: (
      context: BoundContext,
      identity: Awaited<ReturnType<typeof authenticate>>
    ) => Promise<T>
  ) {
    const initial = await deps.serial(readContext);
    const identity = await authenticate(initial, proof);
    return withCurrent(identity, context => operation(context, identity));
  }
  function withCurrent<T>(
    identity: Awaited<ReturnType<typeof authenticate>>,
    action: (context: BoundContext) => T | Promise<T>
  ) {
    return deps.serial(async () => action(await current(identity)));
  }
  return { authenticate, accepted, withCurrent, readContext, serial: deps.serial, now };
}
export type AwsEgressIdentity<
  G extends ScopedScmGrant,
  C extends AwsScopedEgressContext<G>,
> = ReturnType<typeof createAwsEgressIdentity<G, C>>;
