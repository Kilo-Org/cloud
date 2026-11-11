import {
  cloudAgentAuthorityInputSchema,
  type CloudAgentAuthority,
} from '../../../packages/worker-utils/src/cloud-agent-authority';
import { z } from 'zod';
import {
  environmentSetupAgentOperations,
  environmentSetupProcedure,
} from '../../../packages/worker-utils/src/environment-setup-authority';
import { SETUP_SCRIPT_LIMITS } from '../../../packages/worker-utils/src/setup-script';
import { assertInputMatchesSchema, callCatalogEndpoint, MAX_RESULT_BYTES } from './call';
import { JsonRpcFailure, type Catalog, type ForwardedAuth } from './types';

/** A draft carries the full setup script, at up to 3 UTF-8 bytes per character. */
export const ENVIRONMENT_SETUP_RESULT_BYTES = MAX_RESULT_BYTES + 3 * SETUP_SCRIPT_LIMITS.MAX_LENGTH;

export const ENVIRONMENT_SETUP_INSTRUCTIONS =
  'This session is an environment setup session. Use the environment setup tools to read, change, verify, and complete the draft environment; do not edit environments any other way.';

export const environmentSetupOperations = [
  {
    name: 'get_environment_draft',
    procedure: 'getDraft',
    description:
      'Read the draft environment, optional user guidance, script, variable keys, limits, secret requests, and verification. Never returns secret values. Call first and after each follow-up.',
  },
  {
    name: 'update_environment_draft',
    procedure: 'updateDraft',
    description:
      'Save changes to the draft. Pass expectedRevision from get_environment_draft. script replaces the setup script (one Bash script, at most 16,000 characters; empty string removes it). plainVars replaces all plain variables. secrets adds or deletes secrets you generated yourself; never put user-owned credentials here. sandboxAllocation must be offered. Leave the network policy and hosts unchanged. Any change invalidates earlier verifications.',
  },
  {
    name: 'request_environment_secrets',
    procedure: 'requestSecrets',
    description:
      'Ask the user for credentials you cannot generate. For each key give a reason and where the repository uses it (repoFullName, path, line). The user enters values in the environment editor, not in chat. After calling, end your turn and wait for the follow-up message. Never ask for secret values in chat.',
  },
  {
    name: 'verify_environment_draft',
    procedure: 'startVerification',
    description:
      'Run setup from scratch in a fresh sandbox, then run your checks (name, command, expected result). You receive results as a message; call report_verification_results. Fix failures in this setup session before retrying.',
  },
  {
    name: 'report_verification_results',
    procedure: 'recordVerification',
    description:
      'Record the results the verification session reported, for the given childSessionId. The platform adds the facts it observed (setup outcome, revision, duration, network mode) and returns whether the completion gate passes and what is missing.',
  },
  {
    name: 'complete_environment_setup',
    procedure: 'complete',
    description:
      'Finish the run with a short summary for the user. The platform checks the completion gate and then publishes the environment automatically, or asks the user to resolve a conflict. If the gate fails, the error says what is missing.',
  },
  {
    name: 'fail_environment_setup',
    procedure: 'fail',
    description:
      'Stop the run with a specific reason when the requirements cannot be met in a Cloud Agent sandbox or under the current network policy.',
  },
] as const;

export const ENVIRONMENT_SETUP_TOOL_NAMES = new Set<string>(
  environmentSetupOperations.map(operation => operation.name)
);

function setupToolInputSchema(
  authority: CloudAgentAuthority,
  procedure: (typeof environmentSetupOperations)[number]['procedure']
) {
  const schema = cloudAgentAuthorityInputSchema(authority, environmentSetupProcedure(procedure));
  if (procedure !== 'updateDraft') return schema;
  return z.toJSONSchema(
    environmentSetupAgentOperations.updateDraft.schema.omit({ runId: true, requiredHosts: true }),
    { io: 'input' }
  );
}

export function environmentSetupTools(authority: CloudAgentAuthority) {
  if (!authority.environmentSetup) return [];
  return environmentSetupOperations.map(operation => ({
    name: operation.name,
    description: operation.description,
    inputSchema: setupToolInputSchema(authority, operation.procedure),
    annotations: {
      readOnlyHint: operation.procedure === 'getDraft',
      destructiveHint: false,
      idempotentHint: operation.procedure === 'getDraft',
      openWorldHint: false,
    },
  }));
}

export async function runEnvironmentSetupTool(options: {
  name: string;
  args: Record<string, unknown>;
  auth: ForwardedAuth;
  catalog: Catalog;
  webBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ text: string; truncated: boolean }> {
  const { name, args, auth, catalog } = options;
  const operation = environmentSetupOperations.find(operation => operation.name === name);
  if (!operation) throw new JsonRpcFailure(-32602, 'Unknown environment setup tool.');
  const authority = auth.cloudAgentAuthority;
  if (
    !authority?.environmentSetup ||
    authority.ownerId !== auth.kiloUserId ||
    authority.organizationId !== (auth.organizationId ?? null) ||
    authority.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    throw new JsonRpcFailure(-32602, 'Environment setup authority required.');
  }
  const tool = environmentSetupTools(authority).find(tool => tool.name === name);
  if (!tool) throw new JsonRpcFailure(-32602, 'Unknown environment setup tool.');
  const path = environmentSetupProcedure(operation.procedure);
  const row = catalog[path];
  if (!row)
    throw new JsonRpcFailure(
      -32000,
      'Environment setup operation is unavailable in the Kilo catalog.'
    );
  assertInputMatchesSchema({ ...row, inputSchema: tool.inputSchema }, name, args);
  return callCatalogEndpoint({
    ...options,
    path,
    input: { ...args, runId: authority.environmentSetup.runId },
    maxResultBytes: ENVIRONMENT_SETUP_RESULT_BYTES,
  });
}
