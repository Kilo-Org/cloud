import {
  CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
  getSandboxAllocationInstance,
} from '@kilocode/worker-utils/sandbox-allocation';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { logControlDiagnostic } from '../sandbox-control/diagnostics.js';
import {
  activeWarmBaseId,
  readWarmBaseRecord,
  selectWarmBaseWorkspace,
  warmBaseDigest,
  warmBasePaths,
  warmBasePreparationEnvIdentity,
} from '../sandbox-control/warm-base.js';
import { WRAPPER_VERSION } from '../shared/wrapper-version.js';
import { attachBranch } from '../shared/session-branch.js';
import { readProfileBundle } from '../session-profile.js';
import type { AgentSandboxProvider } from '../types.js';
import { buildSessionAttachPayload } from './attach-payload.js';

export type WarmBaseContainerFacts = {
  image: string;
  sessionSnapshotId: string | null;
  hasRecord: boolean;
};

export type WarmBaseLaunchResolution = {
  metadata: SessionMetadata;
  directory: string;
  snapshotId: string | undefined;
  publishDigest: string | undefined;
};

export function warmBaseInstance(metadata: SessionMetadata): string {
  return (
    getSandboxAllocationInstance(metadata.workspace?.sandboxAllocation) ??
    CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE
  );
}

export async function resolveWarmBaseLaunch(input: {
  metadata: SessionMetadata;
  provider: AgentSandboxProvider;
  directory: string;
  readContainerFacts: () => Promise<WarmBaseContainerFacts>;
  readWarmRecord: (digest: string) => Promise<unknown>;
  persistWorkspacePath: (metadata: SessionMetadata, workspacePath: string) => SessionMetadata;
}): Promise<WarmBaseLaunchResolution> {
  const settle = (
    metadata: SessionMetadata,
    publishDigest?: string,
    snapshotId?: string
  ): WarmBaseLaunchResolution => ({
    metadata,
    directory: metadata.workspace?.workspacePath ?? input.directory,
    snapshotId,
    publishDigest,
  });
  if (input.provider !== 'cloudflare-containers' || input.metadata.workspace?.worktreeId) {
    return settle(input.metadata);
  }
  const pinLegacy = () =>
    input.metadata.workspace?.workspacePath === undefined
      ? input.persistWorkspacePath(input.metadata, input.directory)
      : input.metadata;
  let facts: WarmBaseContainerFacts;
  try {
    facts = await input.readContainerFacts();
  } catch {
    logControlDiagnostic(
      'warm_base_resolution',
      { result: 'failed', reason: 'container_identity_unavailable' },
      'warn'
    );
    return settle(pinLegacy());
  }
  const profile = readProfileBundle(input.metadata);
  const preparationEnvIdentity = warmBasePreparationEnvIdentity(
    profile.envVars,
    profile.encryptedSecrets !== undefined
  );
  if (preparationEnvIdentity === undefined) return settle(pinLegacy());
  const payload = buildSessionAttachPayload(input.metadata);
  const digest = await warmBaseDigest({
    owner: input.metadata.identity.orgId ?? input.metadata.identity.userId,
    repositoryUrl: payload.git?.url ?? '',
    ref: attachBranch(payload.branch, input.metadata.identity.sessionId),
    checkoutMode: payload.branchMode === 'working' ? 'working' : 'branch',
    setupCommands: payload.setupCommands ?? [],
    preparationEnvIdentity,
    wrapperVersion: WRAPPER_VERSION,
    image: facts.image,
    instance: warmBaseInstance(input.metadata),
  });
  const paths = warmBasePaths(digest);
  const currentPath = input.metadata.workspace?.workspacePath;
  const decision = selectWarmBaseWorkspace({
    currentPath,
    sessionSlot: facts.sessionSnapshotId,
    hasPreparationHistory: facts.hasRecord,
    legacyDirectory: input.directory,
    expectedWorkspace: paths.workspace,
  });
  if (!decision.eligible) {
    return settle(
      currentPath === undefined
        ? input.persistWorkspacePath(input.metadata, input.directory)
        : input.metadata
    );
  }
  if (decision.continuation) {
    return settle(input.metadata, digest);
  }
  const metadata = input.persistWorkspacePath(input.metadata, paths.workspace);
  let snapshotId: string | undefined;
  try {
    snapshotId = activeWarmBaseId(readWarmBaseRecord(await input.readWarmRecord(digest)), Date.now());
  } catch {
    logControlDiagnostic(
      'warm_base_resolution',
      { result: 'failed', reason: 'record_unavailable' },
      'warn'
    );
    snapshotId = undefined;
  }
  return settle(metadata, digest, snapshotId);
}
