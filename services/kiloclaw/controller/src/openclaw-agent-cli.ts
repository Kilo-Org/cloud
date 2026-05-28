import { execFile } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { normalizeAgentId } from './openclaw-agent-config';

const AGENT_CLI_TIMEOUT_MS = 30_000;
const AGENT_CLI_MAX_OUTPUT_BYTES = 1_048_576;

const CliValueSchema = z
  .string()
  .trim()
  .min(1)
  .refine(value => !value.startsWith('-'), {
    message: 'CLI value must not begin with a dash',
  });

export const BasicAgentCreateBodySchema = z
  .object({
    name: CliValueSchema,
    workspace: z
      .string()
      .trim()
      .min(1)
      .refine(value => path.isAbsolute(value), {
        message: 'Workspace must be an absolute path',
      }),
    agentDir: z
      .string()
      .trim()
      .min(1)
      .refine(value => path.isAbsolute(value), {
        message: 'Agent directory must be an absolute path',
      })
      .optional(),
    model: CliValueSchema.optional(),
    bindings: z.array(CliValueSchema).optional(),
  })
  .strict();

export type BasicAgentCreateBody = z.infer<typeof BasicAgentCreateBodySchema>;

const NormalizedCliAgentIdSchema = z.string().trim().min(1).transform(normalizeAgentId);

const CreateResultSchema = z.object({
  agentId: NormalizedCliAgentIdSchema,
  name: z.string().min(1),
  workspace: z.string().min(1),
  agentDir: z.string().min(1),
  model: z.string().optional(),
  bindings: z
    .object({
      added: z.array(z.string()),
      updated: z.array(z.string()),
      skipped: z.array(z.string()),
      conflicts: z.array(z.string()),
    })
    .optional(),
});

const DeleteResultSchema = z.object({
  agentId: NormalizedCliAgentIdSchema,
  workspace: z.string().min(1),
  agentDir: z.string().min(1),
  sessionsDir: z.string().min(1),
  removedBindings: z.number().int().min(0),
  removedAllow: z.number().int().min(0),
});

export type CreateAgentCliResult = z.infer<typeof CreateResultSchema>;
export type DeleteAgentCliResult = z.infer<typeof DeleteResultSchema>;

type CliProcessResult = {
  stdout: string;
  stderr: string;
};

export type OpenClawAgentCliDeps = {
  run: (args: string[]) => Promise<CliProcessResult>;
};

export class OpenClawAgentCliError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'OpenClawAgentCliError';
    this.status = status;
    this.code = code;
  }
}

const defaultDeps: OpenClawAgentCliDeps = {
  run: args =>
    new Promise((resolve, reject) => {
      execFile(
        'openclaw',
        args,
        {
          env: process.env,
          timeout: AGENT_CLI_TIMEOUT_MS,
          maxBuffer: AGENT_CLI_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          if (error) {
            if ('killed' in error && error.killed === true) {
              reject(
                new OpenClawAgentCliError(
                  504,
                  'openclaw_cli_timeout',
                  'OpenClaw agent command timed out'
                )
              );
              return;
            }
            reject(mapCliFailure(`${stderr}\n${error.message}`));
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    }),
};

function mapCliFailure(output: string): OpenClawAgentCliError {
  if (/cannot be deleted|is reserved/i.test(output)) {
    return new OpenClawAgentCliError(400, 'reserved_agent_id', 'The default agent is reserved');
  }
  if (/already exists/i.test(output)) {
    return new OpenClawAgentCliError(409, 'agent_exists', 'Agent already exists');
  }
  if (/not found/i.test(output)) {
    return new OpenClawAgentCliError(404, 'agent_not_found', 'Agent not found');
  }
  return new OpenClawAgentCliError(502, 'openclaw_cli_failed', 'OpenClaw agent command failed');
}

function parseCliJson<T>(stdout: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new OpenClawAgentCliError(
      502,
      'openclaw_cli_failed',
      'OpenClaw agent command returned invalid JSON'
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new OpenClawAgentCliError(
      502,
      'openclaw_cli_failed',
      'OpenClaw agent command returned an invalid response'
    );
  }
  return result.data;
}

export async function createAgentViaCli(
  body: BasicAgentCreateBody,
  deps: OpenClawAgentCliDeps = defaultDeps
): Promise<CreateAgentCliResult> {
  const args = [
    'agents',
    'add',
    body.name,
    '--workspace',
    body.workspace,
    ...(body.agentDir ? ['--agent-dir', body.agentDir] : []),
    ...(body.model ? ['--model', body.model] : []),
    ...(body.bindings ?? []).flatMap(binding => ['--bind', binding]),
    '--non-interactive',
    '--json',
  ];
  const result = await deps.run(args);
  return parseCliJson(result.stdout, CreateResultSchema);
}

export async function deleteAgentViaCli(
  agentId: string,
  deps: OpenClawAgentCliDeps = defaultDeps
): Promise<DeleteAgentCliResult> {
  const result = await deps.run(['agents', 'delete', agentId, '--force', '--json']);
  return parseCliJson(result.stdout, DeleteResultSchema);
}
