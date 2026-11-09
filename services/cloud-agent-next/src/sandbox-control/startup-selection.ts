import { z } from 'zod';
import { runtimeStartupConfigSchema } from '../shared/runtime-startup-config.js';
import { isValidSandboxId } from '../sandbox-id.js';
import {
  resolveSandboxIdClass,
  sandboxKindMatchesKey,
  type SandboxKind,
} from '../sandbox-placement.js';
import type { RuntimeHarness } from '../shared/control-plane-runtime-contract.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import { ProviderCreationError } from './provider.js';

export type StartupMode = 'preinstalled' | 'downloaded';
export type NativeRuntimeImage = 'all-in-one' | 'runtime-free';
export type StartupSelection =
  | { mode: 'preinstalled'; image: NativeRuntimeImage }
  | { mode: 'downloaded'; image: NativeRuntimeImage; descriptor: string };

export type StartupRouteIdentity = {
  orgId?: string;
  billingOrigin?: string;
};

export type StartupCohortContext = {
  preparingRoutes?: readonly StartupRouteIdentity[];
  sandboxKind?: SandboxKind;
  /** Sandbox key, used for legacy isolation when no kind is stored. */
  sandboxId?: string;
};

const orgIdsSchema = z.array(z.uuid()).min(1);

function configuredOrgIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  const parsed = orgIdsSchema.safeParse(values);
  if (!parsed.success) throw new ProviderCreationError('invalid_configuration');
  return parsed.data;
}

function isIsolatedNativeSandbox(cohort: StartupCohortContext | undefined): boolean {
  if (cohort?.sandboxId === undefined || !isValidSandboxId(cohort.sandboxId)) return false;
  if (!sandboxKindMatchesKey(cohort.sandboxId, cohort.sandboxKind)) return false;
  const sandboxClass = resolveSandboxIdClass({
    sandboxId: cohort.sandboxId,
    ...(cohort.sandboxKind === undefined ? {} : { sandboxKind: cohort.sandboxKind }),
  });
  return sandboxClass === 'isolated-small' || sandboxClass === 'isolated-standard';
}

/**
 * Every preparing route must belong to one configured organization, whatever
 * its origin. Mixed or missing identity stays on the baseline. Native sandboxes
 * must also be isolated.
 */
function inOrgScope(
  provider: AgentSandboxProvider,
  cohort: StartupCohortContext | undefined,
  orgIds: readonly string[]
): boolean {
  if (orgIds.length === 0) return false;
  const routes = cohort?.preparingRoutes ?? [];
  if (routes.length === 0) return false;
  let orgId: string | undefined;
  for (const route of routes) {
    if (route.orgId === undefined || route.orgId === '') return false;
    if (orgId !== undefined && route.orgId !== orgId) return false;
    orgId = route.orgId;
  }
  return (
    orgId !== undefined &&
    orgIds.includes(orgId) &&
    (provider !== 'cloudflare-containers' || isIsolatedNativeSandbox(cohort))
  );
}

type StartupEnv = Pick<
  Env,
  | 'RUNTIME_STARTUP_MODE'
  | 'NATIVE_RUNTIME_IMAGE'
  | 'RUNTIME_RELEASE_DESCRIPTOR'
  | 'RUNTIME_INTERACTIVE_ORG_IDS'
  | 'RUNTIME_RELEASE_DESCRIPTOR_KILO2'
  | 'RUNTIME_KILO2_ORG_IDS'
>;

const BASELINE = { mode: 'preinstalled', image: 'all-in-one' } as const;

function startupTarget(
  env: StartupEnv,
  provider: AgentSandboxProvider,
  cohort: StartupCohortContext | undefined
): typeof BASELINE | { mode: 'downloaded'; image: NativeRuntimeImage } {
  const selected = runtimeStartupConfigSchema.safeParse({
    mode: env.RUNTIME_STARTUP_MODE ?? 'preinstalled',
    image: env.NATIVE_RUNTIME_IMAGE ?? 'all-in-one',
  });
  if (!selected.success) throw new ProviderCreationError('invalid_configuration');
  const { mode, image } = selected.data;
  // The retired SDK provider keeps its preinstalled launch contract.
  if (mode === 'preinstalled' || provider === 'cloudflare') return BASELINE;
  const interactiveOrgIds = configuredOrgIds(env.RUNTIME_INTERACTIVE_ORG_IDS);
  if (interactiveOrgIds !== undefined && !inOrgScope(provider, cohort, interactiveOrgIds))
    return BASELINE;
  return { mode, image };
}

/**
 * The harness a sandbox's first allocation selects. Only a downloaded start in
 * the `RUNTIME_KILO2_ORG_IDS` scope runs v2 when every route has the trusted
 * cloud-agent-web origin.
 * An unset list keeps v1 everywhere.
 */
export function newSandboxHarness(
  env: StartupEnv,
  provider: AgentSandboxProvider,
  cohort?: StartupCohortContext
): RuntimeHarness {
  if (startupTarget(env, provider, cohort).mode !== 'downloaded') return 'kilo';
  const orgIds = configuredOrgIds(env.RUNTIME_KILO2_ORG_IDS);
  return orgIds !== undefined &&
    inOrgScope(provider, cohort, orgIds) &&
    cohort?.preparingRoutes?.every(route => route.billingOrigin === 'cloud-agent-web')
    ? 'kilo2'
    : 'kilo';
}

/** Resolve trusted deployment configuration once per create attempt. */
export function selectStartup(
  env: StartupEnv,
  provider: AgentSandboxProvider,
  cohort?: StartupCohortContext,
  harness: RuntimeHarness = 'kilo'
): StartupSelection {
  const target = startupTarget(env, provider, cohort);
  if (target.mode === 'preinstalled') {
    // Preinstalled images carry only v1, so a v2 sandbox cannot fall back to them.
    if (harness === 'kilo2') throw new ProviderCreationError('invalid_configuration');
    return target;
  }
  const descriptor =
    harness === 'kilo2' ? env.RUNTIME_RELEASE_DESCRIPTOR_KILO2 : env.RUNTIME_RELEASE_DESCRIPTOR;
  if (!descriptor) throw new ProviderCreationError('invalid_configuration');
  return { ...target, descriptor };
}

/** Preserve legacy preinstalled snapshot keys. Downloaded snapshots have a separate namespace. */
export function startupRepositoryKey(repoKey: string, mode: StartupMode): string {
  return mode === 'preinstalled' ? repoKey : `downloaded:${repoKey}`;
}
