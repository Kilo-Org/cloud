import { z } from 'zod';
import { runtimeStartupConfigSchema } from '../shared/runtime-startup-config.js';
import { isValidSandboxId } from '../sandbox-id.js';
import {
  resolveSandboxIdClass,
  sandboxKindMatchesKey,
  type SandboxKind,
} from '../sandbox-placement.js';
import type { RuntimeHarness } from '../shared/control-plane-runtime-contract.js';
import { PROVIDER_DESCRIPTORS } from '../shared/sandbox-provider.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import { ProviderCreationError } from './provider.js';
import { RetiredSandboxProviderError } from './retired-cloudflare-provider.js';

export type StartupMode = 'preinstalled' | 'downloaded';
export type NativeRuntimeImage = 'all-in-one' | 'runtime-free';
export type StartupSelection = { mode: 'downloaded'; image: 'runtime-free'; descriptor: string };

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

function configuredOrgIds(raw: string | undefined): '*' | string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === '*') return '*';
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

function cohortOrgId(cohort: StartupCohortContext | undefined): string | undefined {
  const routes = cohort?.preparingRoutes ?? [];
  if (routes.length === 0) return undefined;
  let orgId: string | undefined;
  for (const route of routes) {
    if (route.orgId === undefined || route.orgId === '') return undefined;
    if (orgId !== undefined && route.orgId !== orgId) return undefined;
    orgId = route.orgId;
  }
  return orgId;
}

function inOrgScope(
  cohort: StartupCohortContext | undefined,
  orgIds: '*' | readonly string[]
): boolean {
  if (orgIds === '*') return true;
  if (orgIds.length === 0) return false;
  const orgId = cohortOrgId(cohort);
  return orgId !== undefined && orgIds.includes(orgId);
}

function allSessionScope(
  cohort: StartupCohortContext | undefined,
  allSessionOrgIds: '*' | readonly string[] | undefined
): boolean {
  if (allSessionOrgIds === undefined) return false;
  if (allSessionOrgIds === '*') return true;
  if (allSessionOrgIds.length === 0) return false;
  const orgId = cohortOrgId(cohort);
  return orgId !== undefined && allSessionOrgIds.includes(orgId);
}

type StartupEnv = Pick<
  Env,
  | 'RUNTIME_STARTUP_MODE'
  | 'NATIVE_RUNTIME_IMAGE'
  | 'RUNTIME_RELEASE_DESCRIPTOR'
  | 'RUNTIME_INTERACTIVE_ORG_IDS'
  | 'RUNTIME_RELEASE_DESCRIPTOR_KILO2'
  | 'RUNTIME_KILO2_ORG_IDS'
  | 'RUNTIME_KILO2_ALL_SESSION_ORG_IDS'
>;

function startupTarget(
  env: StartupEnv,
  provider: AgentSandboxProvider
): { mode: 'downloaded'; image: 'runtime-free' } {
  if (PROVIDER_DESCRIPTORS[provider].retired) throw new RetiredSandboxProviderError('create');
  if (provider === 'vercel') return { mode: 'downloaded', image: 'runtime-free' };
  if (env.RUNTIME_INTERACTIVE_ORG_IDS !== undefined)
    throw new ProviderCreationError('invalid_configuration');
  const selected = runtimeStartupConfigSchema.safeParse({
    mode: env.RUNTIME_STARTUP_MODE ?? 'downloaded',
    image: env.NATIVE_RUNTIME_IMAGE ?? 'runtime-free',
  });
  if (!selected.success) throw new ProviderCreationError('invalid_configuration');
  const { mode, image } = selected.data;
  return { mode, image };
}

/**
 * The harness a sandbox's first allocation selects. Only a downloaded start in
 * the `RUNTIME_KILO2_ORG_IDS` scope runs v2 when every route has the trusted
 * cloud-agent-web origin. `RUNTIME_KILO2_ALL_SESSION_ORG_IDS` admits every
 * origin and native sandbox class for its own accounts. `*` includes all
 * organizations and personal accounts. An unset list keeps v1 everywhere.
 */
export function newSandboxHarness(
  env: StartupEnv,
  provider: AgentSandboxProvider,
  cohort?: StartupCohortContext
): RuntimeHarness {
  startupTarget(env, provider);
  const orgIds = configuredOrgIds(env.RUNTIME_KILO2_ORG_IDS);
  if (orgIds === undefined) return 'kilo';
  const allSessionOrgIds = configuredOrgIds(env.RUNTIME_KILO2_ALL_SESSION_ORG_IDS);
  const allSessions = allSessionScope(cohort, allSessionOrgIds);
  if (!inOrgScope(cohort, orgIds)) return 'kilo';
  if (provider === 'cloudflare-containers' && !allSessions && !isIsolatedNativeSandbox(cohort))
    return 'kilo';
  const routes = cohort?.preparingRoutes ?? [];
  const webOnly =
    routes.length > 0 && routes.every(route => route.billingOrigin === 'cloud-agent-web');
  return routes.length > 0 && (webOnly || allSessions) ? 'kilo2' : 'kilo';
}

/** Resolve trusted deployment configuration once per create attempt. */
export function selectStartup(
  env: StartupEnv,
  provider: AgentSandboxProvider,
  _cohort?: StartupCohortContext,
  harness: RuntimeHarness = 'kilo'
): StartupSelection {
  const target = startupTarget(env, provider);
  const descriptor =
    harness === 'kilo2' ? env.RUNTIME_RELEASE_DESCRIPTOR_KILO2 : env.RUNTIME_RELEASE_DESCRIPTOR;
  if (!descriptor) throw new ProviderCreationError('invalid_configuration');
  return { ...target, descriptor };
}
