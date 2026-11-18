import type {
  EnvironmentBuildInput,
  EnvironmentBuildGit,
} from '../shared/environment-build-protocol.js';
import { ScmCapabilityIssueError } from '../scm-broker/failure.js';
import type { BuilderGitSource, resolveBuilderGitSource } from './access.js';
import { AwsBuildInactiveError } from './aws-build-context.js';
import { BuilderStateInvalidError, BuilderTargetMismatchError } from './builder-errors.js';
import type { AwsEnvironmentBuildServices } from './aws-build.js';
import { buildInputMembers, environmentBuildRunnerInput } from './build-input.js';
import { buildNetworkSecretEnvironment } from './network-secrets.js';
import { parseBuildInput, type BuildRow } from './store.js';

type PreparationRefusal =
  | { refused: 'gone' | 'unavailable' | 'repository_unauthorized' }
  | { refused: 'input_unavailable'; detail: string };

/** Runner data and artifact checks. Compute and egress transport have separate owners. */
export interface BuilderPreparation {
  prepareInput(build: BuildRow): Promise<EnvironmentBuildInput | PreparationRefusal>;
  confirmArtifact(build: BuildRow): 'ready' | 'archive_failed';
}

type PreparationDeps = {
  gitSource(input: Parameters<typeof resolveBuilderGitSource>[1]): Promise<BuilderGitSource>;
  decryptSecrets(encrypted: Record<string, unknown>): Record<string, string>;
  aws?: Pick<AwsEnvironmentBuildServices, 'input' | 'assertReady'>;
};

export function createBuilderPreparation(deps: PreparationDeps): BuilderPreparation {
  return {
    async prepareInput(build) {
      const input = parseBuildInput(build);
      const members = buildInputMembers(input);
      if (members.length === 0)
        return { refused: 'input_unavailable', detail: 'build has no repository' };
      if (build.allocation_id === null) return { refused: 'gone' };
      let secrets: Record<string, string>;
      let networkEnv: Record<string, string>;
      try {
        secrets =
          build.encrypted_secrets === null
            ? {}
            : deps.decryptSecrets(JSON.parse(build.encrypted_secrets) as Record<string, unknown>);
        networkEnv = buildNetworkSecretEnvironment(build);
      } catch {
        return { refused: 'input_unavailable', detail: 'secrets could not be decrypted' };
      }
      const common = {
        environmentId: input.reference.environmentId,
        buildId: build.id,
        allocationId: build.allocation_id,
        commands: input.commands,
        env: { ...input.plainVars, ...secrets, ...networkEnv },
        secretKeys: [...Object.keys(secrets), ...Object.keys(networkEnv)],
        deadlineAt: build.deadline_at,
      };
      const provider = input.target?.provider;
      if (provider === 'aws' || provider === 'aws-ecs') {
        if (!deps.aws) return { refused: 'unavailable' };
        try {
          const prepared = await deps.aws.input(build.id);
          return environmentBuildRunnerInput({
            common: { ...common, filesystemArchive: { baseImage: prepared.baseImage } },
            reference: input.reference,
            sources: prepared.sources,
          });
        } catch (error) {
          if (error instanceof AwsBuildInactiveError) return { refused: 'gone' };
          if (error instanceof ScmCapabilityIssueError && error.kind === 'denied')
            return { refused: 'repository_unauthorized' };
          if (error instanceof BuilderStateInvalidError || error instanceof BuilderTargetMismatchError)
            return { refused: 'input_unavailable', detail: error.message };
          return { refused: 'unavailable' };
        }
      }
      const sources: EnvironmentBuildGit[] = [];
      for (const member of members) {
        const git = await deps.gitSource({
          reference: input.reference,
          member,
          actorUserId: build.actor_user_id,
        });
        if (!git.ok) return { refused: git.reason };
        sources.push(git.git);
      }
      return environmentBuildRunnerInput({ common, reference: input.reference, sources });
    },
    confirmArtifact(build) {
      const provider = parseBuildInput(build).target?.provider;
      if (provider !== 'aws' && provider !== 'aws-ecs') return 'ready';
      if (!deps.aws) return 'archive_failed';
      try {
        deps.aws.assertReady(build.id);
        return 'ready';
      } catch {
        return 'archive_failed';
      }
    },
  };
}
