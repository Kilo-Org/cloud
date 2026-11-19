import type { EnvironmentBuildArchiveRequest } from '../shared/environment-build-archive.js';
import type { RunnerAuth, RunnerRefusal } from './coordinator.js';
import type { BuildRow } from './store.js';
import type { AwsEnvironmentBuildServices } from './aws-build.js';
import { AwsBuildInactiveError } from './aws-build-context.js';
import { AwsBuildArchiveError } from './aws-archive-storage.js';

/** Authenticated build callbacks; compute and coordinator interfaces carry no egress transport. */
export function createAwsBuildEndpoints(deps: {
  aws: AwsEnvironmentBuildServices;
  authorizePreparing(auth: RunnerAuth): Promise<BuildRow | RunnerRefusal>;
}) {
  const { aws } = deps;
  return {
    policy: aws.policy,
    audit: aws.audit,
    admitScm: aws.admitScm,
    async retireScm(auth: RunnerAuth): Promise<'ok' | RunnerRefusal> {
      const build = await deps.authorizePreparing(auth);
      if ('refused' in build) return build;
      try {
        aws.retireScm(build.id);
        return 'ok';
      } catch (error) {
        return { refused: error instanceof AwsBuildInactiveError ? 'gone' : 'unavailable' };
      }
    },
    async archive(auth: RunnerAuth, request: EnvironmentBuildArchiveRequest) {
      const build = await deps.authorizePreparing(auth);
      if ('refused' in build) return build;
      try {
        return await aws.archive(build.id, request);
      } catch (error) {
        if (error instanceof AwsBuildInactiveError) return { refused: 'gone' as const };
        if (
          error instanceof AwsBuildArchiveError &&
          ['archive_invalid', 'archive_conflict'].includes(error.code)
        )
          return { refused: 'unauthorized' as const };
        return { refused: 'unavailable' as const };
      }
    },
  };
}
