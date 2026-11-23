import { environmentWorkspace } from '../shared/environment-workspace.js';
import {
  ENVIRONMENT_BUILD_WORKSPACE,
  type EnvironmentBuildInput,
  type EnvironmentBuildGit,
} from '../shared/environment-build-protocol.js';
import type {
  EnvironmentReferenceRepository,
  EnvironmentBuildInput as ProfileBuildInput,
} from '@kilocode/cloud-agent-profile';
import { repositoryLeaf } from '@kilocode/cloud-agent-profile';
import type { BuildInputRecord } from './store.js';
import type { EnvironmentBuildTarget } from './target.js';

export function buildInputMembers(record: BuildInputRecord): EnvironmentReferenceRepository[] {
  if (record.repoFullName === undefined) return [...record.reference.repositories];
  return [
    {
      identity: record.reference.repository,
      repoFullName: record.repoFullName,
      leaf: repositoryLeaf(record.repoFullName),
    },
  ];
}

/**
 * Only the AWS builder reads `egressPolicy`. Other targets omit it, so the
 * previous release's strict record schema still reads their builds after a
 * revert deploy.
 */
function egressPolicyOf(
  input: ProfileBuildInput,
  target: EnvironmentBuildTarget
): Pick<BuildInputRecord, 'egressPolicy'> {
  if (target.provider !== 'aws' && target.provider !== 'aws-ecs') return {};
  if (input.egressMode === undefined) return {};
  return {
    egressPolicy:
      input.egressMode === 'allowlist'
        ? { egressMode: 'allowlist', egressAllowlist: input.egressAllowlist ?? [] }
        : { egressMode: 'unrestricted' },
  };
}

/** The stored input JSON for a profile build input: one path, or the V2 repositories. */
export function buildInputRecordOf(
  input: ProfileBuildInput,
  target: EnvironmentBuildTarget
): BuildInputRecord {
  const { reference, commands, plainVars } = input;
  const policy = egressPolicyOf(input, target);
  if (reference.repositories !== undefined)
    return { reference, commands, plainVars, ...policy, target };
  if (input.repoFullName === undefined) throw new Error('A V1 build input has no repository path');
  return { reference, repoFullName: input.repoFullName, commands, plainVars, ...policy, target };
}

/** Native and BYOC builders receive the same repository layout and input shape. */
export function environmentBuildRunnerInput(input: {
  common: Pick<
    EnvironmentBuildInput,
    | 'environmentId'
    | 'buildId'
    | 'allocationId'
    | 'commands'
    | 'env'
    | 'secretKeys'
    | 'deadlineAt'
    | 'filesystemArchive'
  >;
  reference: BuildInputRecord['reference'];
  sources: readonly EnvironmentBuildGit[];
}): EnvironmentBuildInput {
  const workspace = environmentWorkspace({
    sessionDirectory: ENVIRONMENT_BUILD_WORKSPACE,
    environment: input.reference,
  });
  if (input.reference.repositories !== undefined) {
    if (input.sources.length !== input.reference.repositories.length)
      throw new Error('Build repository inputs are incomplete');
    return {
      ...input.common,
      members: input.sources.map((source, index) => {
        const root = workspace.roots[index];
        const member = input.reference.repositories?.[index];
        if (!root || !member) throw new Error('Build repository layout is invalid');
        return { ...source, directory: root.directory, repoFullName: member.repoFullName };
      }),
      directory: workspace.cwd,
    };
  }
  const [git] = input.sources;
  if (!git || input.sources.length !== 1) throw new Error('Build repository inputs are incomplete');
  return { ...input.common, git, directory: ENVIRONMENT_BUILD_WORKSPACE };
}
