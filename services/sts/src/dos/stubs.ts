import type { Env, StsConfig } from '../env';
import type { BundleDO } from './BundleDO';
import type { DenialDO } from './DenialDO';
import type { RefresherDO } from './RefresherDO';
import type { SignerDO } from './SignerDO';

/** Durable Object names carry the environment so a staging object can never serve production. */
export function bundleObjectName(environment: string, workload: string): string {
  return `${environment}:${workload}`;
}

/**
 * Secret-holding objects live in the `eu` jurisdiction in production and staging.
 * workerd enforces no residency, so local development and tests set `DO_JURISDICTION`
 * to `none` and address the same names in the default jurisdiction.
 */
function scoped<Instance extends Rpc.DurableObjectBranded | undefined>(
  config: StsConfig,
  namespace: DurableObjectNamespace<Instance>
): DurableObjectNamespace<Instance> {
  return config.jurisdiction === 'eu' ? namespace.jurisdiction('eu') : namespace;
}

export function getBundleStub(
  env: Env,
  config: StsConfig,
  workload: string
): DurableObjectStub<BundleDO> {
  const namespace = scoped(config, env.STS_BUNDLE_DO);
  return namespace.get(namespace.idFromName(bundleObjectName(config.environment, workload)));
}

export function getRefresherStub(env: Env, config: StsConfig): DurableObjectStub<RefresherDO> {
  const namespace = scoped(config, env.STS_REFRESHER_DO);
  return namespace.get(namespace.idFromName(config.environment));
}

export function getSignerStub(env: Env, config: StsConfig): DurableObjectStub<SignerDO> {
  const namespace = scoped(config, env.STS_SIGNER_DO);
  return namespace.get(namespace.idFromName(config.environment));
}

export function getDenialStub(env: Env, config: StsConfig): DurableObjectStub<DenialDO> {
  const namespace = scoped(config, env.STS_DENIAL_DO);
  return namespace.get(namespace.idFromName(config.environment));
}
