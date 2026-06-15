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

// Raw result that does NOT reject on a non-zero exit — `openclaw agents bind`
// exits 1 on a binding conflict while still printing its JSON summary, so we
// must capture stdout regardless of exit code.
type CliRawResult = {
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type OpenClawAgentCliDeps = {
  run: (args: string[]) => Promise<CliProcessResult>;
  runRaw: (args: string[]) => Promise<CliRawResult>;
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
  runRaw: args =>
    new Promise(resolve => {
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
          const timedOut = !!error && 'killed' in error && error.killed === true;
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', timedOut });
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

// ── Bindings (controller delegates all routing semantics to the CLI) ──

// `openclaw agents bindings [--agent <id>] --json` output entry.
const CliBindingMatchSchema = z.object({ channel: z.string().min(1) }).passthrough();
const CliBindingSchema = z
  .object({
    agentId: NormalizedCliAgentIdSchema,
    match: CliBindingMatchSchema,
    description: z.string().optional(),
  })
  .passthrough();
const ListBindingsResultSchema = z.array(CliBindingSchema);

// `agents bind --json` summary. `conflicts` are descriptive strings.
const BindResultSchema = z.object({
  agentId: NormalizedCliAgentIdSchema,
  added: z.array(z.string()),
  updated: z.array(z.string()),
  skipped: z.array(z.string()),
  conflicts: z.array(z.string()),
});
const UnbindResultSchema = z.object({
  agentId: NormalizedCliAgentIdSchema,
  removed: z.array(z.string()),
  missing: z.array(z.string()),
  conflicts: z.array(z.string()),
});

export type CliBinding = z.infer<typeof CliBindingSchema>;
export type BindAgentCliResult = z.infer<typeof BindResultSchema>;
export type UnbindAgentCliResult = z.infer<typeof UnbindResultSchema>;

export async function listAgentBindingsViaCli(
  agentId: string | undefined,
  deps: OpenClawAgentCliDeps = defaultDeps
): Promise<CliBinding[]> {
  const args = ['agents', 'bindings', ...(agentId ? ['--agent', agentId] : []), '--json'];
  const result = await deps.run(args);
  return parseCliJson(result.stdout, ListBindingsResultSchema);
}

// Parse a bind/unbind raw result: the CLI prints JSON even when it exits 1 on a
// conflict, so prefer stdout; fall back to typed failures (timeout / not-found).
function parseRawCliResult<T>(raw: CliRawResult, schema: z.ZodType<T>): T {
  try {
    return parseCliJson(raw.stdout, schema);
  } catch {
    if (raw.timedOut) {
      throw new OpenClawAgentCliError(
        504,
        'openclaw_cli_timeout',
        'OpenClaw agent command timed out'
      );
    }
    throw mapCliFailure(`${raw.stderr}\n${raw.stdout}`);
  }
}

// Each spec is `channel[:accountId]`.
export async function bindAgentViaCli(
  agentId: string,
  specs: string[],
  deps: OpenClawAgentCliDeps = defaultDeps
): Promise<BindAgentCliResult> {
  const args = [
    'agents',
    'bind',
    '--agent',
    agentId,
    ...specs.flatMap(spec => ['--bind', spec]),
    '--json',
  ];
  return parseRawCliResult(await deps.runRaw(args), BindResultSchema);
}

export async function unbindAgentViaCli(
  agentId: string,
  specs: string[],
  deps: OpenClawAgentCliDeps = defaultDeps
): Promise<UnbindAgentCliResult> {
  const args = [
    'agents',
    'unbind',
    '--agent',
    agentId,
    ...specs.flatMap(spec => ['--bind', spec]),
    '--json',
  ];
  return parseRawCliResult(await deps.runRaw(args), UnbindResultSchema);
}
