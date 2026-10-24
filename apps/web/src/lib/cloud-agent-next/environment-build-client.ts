import 'server-only';
import {
  environmentBuildCancelResultSchema,
  environmentBuildLogsSchema,
  environmentBuildRequestResultSchema,
  environmentBuildStatusSchema,
  type EnvironmentBuildCancelResult,
  type EnvironmentBuildLogs,
  type EnvironmentBuildRequestResult,
  type EnvironmentBuildStatus,
} from '../../../../../services/cloud-agent-next/src/shared/environment-build-status';
import { createCloudAgentNextClient, rethrowCloudAgentError } from './cloud-agent-client';

/**
 * Environment build calls to the cloud-agent-next Worker. The Worker
 * authorizes each one again (owner, organization role, repository); the web
 * router's role check only shapes the UI's errors.
 */

type Scope = { environmentId: string; kilocodeOrganizationId?: string };

type EnvironmentBuildProcedures = {
  buildEnvironment: {
    mutate(input: Scope & { expectedRevision: number; requestId: string }): Promise<unknown>;
  };
  getEnvironmentBuildStatus: { query(input: Scope): Promise<unknown> };
  getEnvironmentBuildLogs: {
    query(input: Scope & { buildId: string; cursor?: number; limit: number }): Promise<unknown>;
  };
  cancelEnvironmentBuild: { mutate(input: Scope & { buildId: string }): Promise<unknown> };
  notifyEnvironmentDeleted: { mutate(input: { environmentId: string }): Promise<unknown> };
};

export type EnvironmentBuildClient = {
  build(
    input: Scope & { expectedRevision: number; requestId: string }
  ): Promise<EnvironmentBuildRequestResult>;
  status(input: Scope): Promise<EnvironmentBuildStatus>;
  logs(
    input: Scope & { buildId: string; cursor?: number; limit: number }
  ): Promise<EnvironmentBuildLogs>;
  cancel(input: Scope & { buildId: string }): Promise<EnvironmentBuildCancelResult>;
  environmentDeleted(environmentId: string): Promise<void>;
};

async function call<T>(
  operation: () => Promise<unknown>,
  parse: (value: unknown) => T
): Promise<T> {
  try {
    return parse(await operation());
  } catch (error) {
    rethrowCloudAgentError(error);
  }
}

export function createEnvironmentBuildClient(authToken: string): EnvironmentBuildClient {
  const client = createCloudAgentNextClient(authToken).getClient() as EnvironmentBuildProcedures;
  return {
    build: input =>
      call(
        () => client.buildEnvironment.mutate(input),
        value => environmentBuildRequestResultSchema.parse(value)
      ),
    status: input =>
      call(
        () => client.getEnvironmentBuildStatus.query(input),
        value => environmentBuildStatusSchema.parse(value)
      ),
    logs: input =>
      call(
        () => client.getEnvironmentBuildLogs.query(input),
        value => environmentBuildLogsSchema.parse(value)
      ),
    cancel: input =>
      call(
        () => client.cancelEnvironmentBuild.mutate(input),
        value => environmentBuildCancelResultSchema.parse(value)
      ),
    environmentDeleted: async environmentId => {
      await call(
        () => client.notifyEnvironmentDeleted.mutate({ environmentId }),
        () => undefined
      );
    },
  };
}
