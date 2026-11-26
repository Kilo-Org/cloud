import { TOKEN_SIGNER_SHARDS } from '../constants';
import type { Env, StsConfig } from '../env';
import type { BundleDO } from './BundleDO';
import type { DenialDO } from './DenialDO';
import type { DeployTokenDO } from './DeployTokenDO';
import type { LeaseDO } from './LeaseDO';
import type { RefresherDO } from './RefresherDO';
import type { SignerDO } from './SignerDO';
import type { TokenSignerDO } from './TokenSignerDO';

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

/** The environment's lease object: its lease records and the `sts:<environment>:leases` stream. */
export function getLeaseStub(env: Env, config: StsConfig): DurableObjectStub<LeaseDO> {
  const namespace = scoped(config, env.STS_LEASE_DO);
  return namespace.get(namespace.idFromName(config.environment));
}

/**
 * The environment's deploy-token object: its token ledger, the reaper, and the
 * `sts:<environment>:deploy-tokens` stream.
 */
export function getDeployTokenStub(env: Env, config: StsConfig): DurableObjectStub<DeployTokenDO> {
  const namespace = scoped(config, env.STS_DEPLOY_TOKEN_DO);
  return namespace.get(namespace.idFromName(config.environment));
}

/**
 * The token signer shard one mint call uses: chosen at random per call, so the instances of one
 * workload spread over every shard however large its fleet is. Any shard can sign for any
 * workload; the key set lists the keys of every shard.
 */
export function pickTokenSignerShard(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % TOKEN_SIGNER_SHARDS;
}

/**
 * One token signer shard of the environment: its own key ring and its
 * `sts:<environment>:tokens:<shard>` audit stream.
 */
export function getTokenSignerStub(
  env: Env,
  config: StsConfig,
  shard: number
): DurableObjectStub<TokenSignerDO> {
  const namespace = scoped(config, env.STS_TOKEN_SIGNER_DO);
  return namespace.get(namespace.idFromName(`${config.environment}:${shard}`));
}
