import 'server-only';
import {
  createCloudAgentNextClient,
  rethrowCloudAgentError,
  type EnvironmentBuildCancelInput,
  type EnvironmentBuildCancelResult,
  type EnvironmentBuildLogs,
  type EnvironmentBuildLogsInput,
  type EnvironmentBuildRequestInput,
  type EnvironmentBuildRequestResult,
  type EnvironmentBuildScope,
  type EnvironmentBuildStatus,
} from './cloud-agent-client';

/**
 * Environment build calls to the cloud-agent-next Worker. The Worker
 * authorizes each one again (owner, organization role, repository); the web
 * router's role check only shapes the UI's errors.
 */

export type EnvironmentBuildClient = {
  build(input: EnvironmentBuildRequestInput): Promise<EnvironmentBuildRequestResult>;
  status(input: EnvironmentBuildScope): Promise<EnvironmentBuildStatus>;
  logs(input: EnvironmentBuildLogsInput): Promise<EnvironmentBuildLogs>;
  cancel(input: EnvironmentBuildCancelInput): Promise<EnvironmentBuildCancelResult>;
  environmentDeleted(environmentId: string): Promise<void>;
};

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowCloudAgentError(error);
  }
}

export function createEnvironmentBuildClient(authToken: string): EnvironmentBuildClient {
  const client = createCloudAgentNextClient(authToken);
  return {
    build: input => call(() => client.buildEnvironment(input)),
    status: input => call(() => client.getEnvironmentBuildStatus(input)),
    logs: input => call(() => client.getEnvironmentBuildLogs(input)),
    cancel: input => call(() => client.cancelEnvironmentBuild(input)),
    environmentDeleted: environmentId =>
      call(() => client.notifyEnvironmentDeleted({ environmentId })),
  };
}
