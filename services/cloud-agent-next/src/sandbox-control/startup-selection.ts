import { z } from 'zod';
import { runtimeStartupConfigSchema } from '../shared/runtime-startup-config.js';
import { isValidSandboxId } from '../sandbox-id.js';
import {
  resolveSandboxIdClass,
  sandboxKindMatchesKey,
  type SandboxKind,
} from '../sandbox-placement.js';
import type { AgentSandboxProvider, Env } from '../types.js';
import { ProviderCreationError } from './provider.js';

export type StartupMode = 'preinstalled' | 'downloaded';
export type NativeRuntimeImage = 'all-in-one' | 'runtime-free';
export type StartupSelection =
  | { mode: 'preinstalled'; image: NativeRuntimeImage }
  | { mode: 'downloaded'; image: NativeRuntimeImage; descriptor: string };

export type StartupRouteIdentity = {
  createdOnPlatform?: string;
  clientProvenance?: 'browser' | 'mobile' | 'agent-manager';
  orgId?: string;
};

export type StartupCohortContext = {
  preparingRoutes?: readonly StartupRouteIdentity[];
  sandboxKind?: SandboxKind;
  /** Sandbox key, used for legacy isolation when no kind is stored. */
  sandboxId?: string;
};

const interactiveOrgIdsSchema = z.array(z.uuid()).min(1);

function configuredInteractiveOrgIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  const parsed = interactiveOrgIdsSchema.safeParse(values);
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
 * Every preparing route must be an exact interactive web route for one
 * configured organization. Mixed or missing identity stays on the baseline.
 */
function isScopedCohort(
  cohort: StartupCohortContext | undefined,
  interactiveOrgIds: readonly string[]
): boolean {
  if (interactiveOrgIds.length === 0) return false;
  const routes = cohort?.preparingRoutes ?? [];
  if (routes.length === 0) return false;
  let orgId: string | undefined;
  for (const route of routes) {
    if (route.createdOnPlatform !== 'cloud-agent-web') return false;
    if (route.clientProvenance !== 'browser') return false;
    if (route.orgId === undefined || route.orgId === '') return false;
    if (orgId !== undefined && route.orgId !== orgId) return false;
    orgId = route.orgId;
  }
  return orgId !== undefined && interactiveOrgIds.includes(orgId);
}

/** Resolve trusted deployment configuration once per create attempt. */
export function selectStartup(
  env: Pick<
    Env,
    | 'RUNTIME_STARTUP_MODE'
    | 'NATIVE_RUNTIME_IMAGE'
    | 'RUNTIME_RELEASE_DESCRIPTOR'
    | 'RUNTIME_INTERACTIVE_ORG_IDS'
  >,
  provider: AgentSandboxProvider,
  cohort?: StartupCohortContext
): StartupSelection {
  const selected = runtimeStartupConfigSchema.safeParse({
    mode: env.RUNTIME_STARTUP_MODE ?? 'preinstalled',
    image: env.NATIVE_RUNTIME_IMAGE ?? 'all-in-one',
  });
  if (!selected.success) throw new ProviderCreationError('invalid_configuration');
  const { mode, image } = selected.data;
  // The retired SDK provider keeps its preinstalled launch contract.
  if (mode === 'preinstalled' || provider === 'cloudflare')
    return { mode: 'preinstalled', image: 'all-in-one' };
  // The organization cohort scopes native containers only; Vercel follows the deployment mode.
  const interactiveOrgIds = configuredInteractiveOrgIds(env.RUNTIME_INTERACTIVE_ORG_IDS);
  if (
    provider === 'cloudflare-containers' &&
    interactiveOrgIds !== undefined &&
    (!isIsolatedNativeSandbox(cohort) || !isScopedCohort(cohort, interactiveOrgIds))
  )
    return { mode: 'preinstalled', image: 'all-in-one' };
  if (!env.RUNTIME_RELEASE_DESCRIPTOR) throw new ProviderCreationError('invalid_configuration');
  return { mode, image, descriptor: env.RUNTIME_RELEASE_DESCRIPTOR };
}

/** Preserve legacy preinstalled snapshot keys. Downloaded snapshots have a separate namespace. */
export function startupRepositoryKey(repoKey: string, mode: StartupMode): string {
  return mode === 'preinstalled' ? repoKey : `downloaded:${repoKey}`;
}
