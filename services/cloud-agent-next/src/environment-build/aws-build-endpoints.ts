import type { RunnerAuth, RunnerRefusal } from './coordinator.js';
import type { BuildRow } from './store.js';
import type { AwsEnvironmentBuildServices } from './aws-build.js';
import { AwsBuildInactiveError } from './aws-build-context.js';

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
  };
}
