import { z } from 'zod';

const VERCEL_SANDBOX_API_BASE_URL = 'https://api.vercel.com';
const VERCEL_SANDBOX_NAME = /^ses-[A-Za-z0-9_-]+$/;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_NDJSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_NDJSON_LINE_BYTES = 256 * 1024;
const MAX_NDJSON_LINES = 2;
const OBSERVATION_CONTROL_DEADLINE_MS = 30_000;
const STANDARD_REQUEST_DEADLINE_MS = 120_000;
const WAITED_COMMAND_TRANSPORT_ALLOWANCE_MS = 10_000;
const MAX_PROVIDER_REQUEST_DEADLINE_MS = 300_000;

export const VERCEL_CLOUD_AGENT_RESOURCE_TAG = 'kilo-managed-by';
export const VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE = 'cloud-agent-session';
export const VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG = 'kilo-create-operation';
export const VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG = 'kilo-runtime-build';

const runtimeSchema = z.enum(['node22', 'node24', 'node26', 'python3.13']);
const statusSchema = z.enum([
  'failed',
  'aborted',
  'pending',
  'stopping',
  'snapshotting',
  'running',
  'stopped',
]);
const sandboxResourceSchema = z.object({
  name: z.string(),
  currentSessionId: z.string(),
  status: z.enum(['stopping', 'running', 'stopped']),
  persistent: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  tags: z.record(z.string(), z.string()).optional().default({}),
});
const sessionSchema = z.object({
  id: z.string(),
  sourceSandboxName: z.string(),
  projectId: z.string(),
  sourceSnapshotId: z.string().optional(),
  runtime: z.string(),
  status: statusSchema,
  memory: z.number(),
  vcpus: z.number(),
  region: z.string(),
  timeout: z.number(),
  requestedAt: z.number(),
  startedAt: z.number().optional(),
  requestedStopAt: z.number().optional(),
  stoppedAt: z.number().optional(),
  abortedAt: z.number().optional(),
  duration: z.number().optional(),
  cwd: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const routeSchema = z.object({
  url: z.string(),
  subdomain: z.string(),
  port: z.number(),
});
const commandSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  sessionId: z.string(),
  exitCode: z.number().nullable(),
  startedAt: z.number(),
});
const finishedCommandSchema = commandSchema.extend({ exitCode: z.number() });
const sandboxEnvelopeSchema = z.object({
  sandbox: sandboxResourceSchema,
  session: sessionSchema,
  routes: z.array(routeSchema),
});
const inspectedSandboxEnvelopeSchema = sandboxEnvelopeSchema.extend({ resumed: z.literal(false) });
const sessionEnvelopeSchema = z.object({ session: sessionSchema });
const sessionAndRoutesEnvelopeSchema = sessionEnvelopeSchema.extend({
  routes: z.array(routeSchema),
});
const commandEnvelopeSchema = z.object({ command: commandSchema });
const finishedCommandEnvelopeSchema = z.object({ command: finishedCommandSchema });
const commandsEnvelopeSchema = z.object({ commands: z.array(commandSchema) });

export type VercelSandboxRuntime = z.infer<typeof runtimeSchema>;
export type VercelSandboxResource = z.infer<typeof sandboxResourceSchema>;
export type VercelSandboxSession = z.infer<typeof sessionSchema>;
export type VercelSandboxRoute = z.infer<typeof routeSchema>;
export type VercelSandboxCommand = z.infer<typeof commandSchema>;

export type VercelSandboxRestClientConfig = {
  accessToken: string;
  projectId?: string;
  teamId: string;
  fetch: typeof fetch;
};

export type CreateSandboxInput = {
  name: string;
  operationId: string;
  runtimeBuildId: string;
  snapshotId: string;
  runtime: VercelSandboxRuntime;
  timeoutMs: number;
};

export type VercelSandboxCreateEnvelope = {
  sandbox: VercelSandboxResource;
  session: VercelSandboxSession;
  routes: VercelSandboxRoute[];
  runtime: { sandboxName: string; sessionId: string };
};

export type ExecuteCommandInput = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  sudo: boolean;
  timeoutMs?: number;
  wait: boolean;
};

export type WaitedCommandResult = {
  command: VercelSandboxCommand;
  finished: VercelSandboxCommand & { exitCode: number };
};

export type VercelSandboxFile = {
  path: string;
  content: string | Uint8Array;
};

type VercelSandboxOperation =
  | 'inspect'
  | 'create'
  | 'get-session'
  | 'execute-command'
  | 'list-commands'
  | 'get-command'
  | 'kill-command'
  | 'write-files'
  | 'read-file'
  | 'extend-timeout'
  | 'stop-session';
export type VercelSandboxErrorKind =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'request_failed'
  | 'invalid_response'
  | 'response_too_large'
  | 'correlation_mismatch';

export class VercelSandboxRestError extends Error {
  constructor(
    public readonly kind: VercelSandboxErrorKind,
    public readonly operation: VercelSandboxOperation,
    public readonly status?: number
  ) {
    super(
      status === undefined
        ? `Vercel Sandbox ${operation} failed (${kind})`
        : `Vercel Sandbox ${operation} failed (${kind}, status ${status})`
    );
    this.name = 'VercelSandboxRestError';
  }
}

function requireValue(value: string, operation: VercelSandboxOperation): void {
  if (value.length === 0) throw new VercelSandboxRestError('invalid_configuration', operation);
}

function requireIdentifier(value: string, operation: VercelSandboxOperation): void {
  if (value.length === 0 || value.length > 256) {
    throw new VercelSandboxRestError('invalid_request', operation);
  }
}

function requireSandboxName(name: string, operation: VercelSandboxOperation): void {
  if (name.length > 128 || !VERCEL_SANDBOX_NAME.test(name)) {
    throw new VercelSandboxRestError('invalid_request', operation);
  }
}

function requirePositiveDuration(value: number, operation: VercelSandboxOperation): void {
  if (!Number.isInteger(value) || value < 1000) {
    throw new VercelSandboxRestError('invalid_request', operation);
  }
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength >= length)
    throw new VercelSandboxRestError('invalid_request', 'write-files');
  header.set(bytes, offset);
}

function writeTarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  writeTarString(header, offset, length, value.toString(8).padStart(length - 1, '0'));
}

async function createGzipTar(files: VercelSandboxFile[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('..')) {
      throw new VercelSandboxRestError('invalid_request', 'write-files');
    }
    const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, file.path);
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.byteLength);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarString(header, 257, 8, 'ustar  ');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarOctal(header, 148, 8, checksum);
    chunks.push(header, content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const stream = new Blob(chunks).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function correlateSession(
  session: VercelSandboxSession,
  expectedSessionId: string,
  expectedSandboxName: string | undefined,
  operation: VercelSandboxOperation
): void {
  if (
    session.id !== expectedSessionId ||
    (expectedSandboxName !== undefined && session.sourceSandboxName !== expectedSandboxName)
  ) {
    throw new VercelSandboxRestError('correlation_mismatch', operation);
  }
}

function correlateCommand(
  command: VercelSandboxCommand,
  expectedSessionId: string,
  expectedCommandId: string | undefined,
  operation: VercelSandboxOperation
): void {
  if (
    command.sessionId !== expectedSessionId ||
    (expectedCommandId !== undefined && command.id !== expectedCommandId)
  ) {
    throw new VercelSandboxRestError('correlation_mismatch', operation);
  }
}

export class VercelSandboxRestClient {
  private readonly responseSignals = new WeakMap<Response, AbortSignal>();

  constructor(private readonly config: VercelSandboxRestClientConfig) {}

  async createSandbox(input: CreateSandboxInput): Promise<VercelSandboxCreateEnvelope> {
    const operation = 'create';
    const projectId = this.requireProjectConfiguration(operation);
    requireSandboxName(input.name, operation);
    requireIdentifier(input.operationId, operation);
    requireIdentifier(input.runtimeBuildId, operation);
    requireIdentifier(input.snapshotId, operation);
    requirePositiveDuration(input.timeoutMs, operation);
    if (!runtimeSchema.safeParse(input.runtime).success) {
      throw new VercelSandboxRestError('invalid_request', operation);
    }

    const response = await this.fetchProvider(operation, this.collectionUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        name: input.name,
        source: { type: 'snapshot', snapshotId: input.snapshotId },
        runtime: input.runtime,
        timeout: input.timeoutMs,
        persistent: false,
        tags: {
          [VERCEL_CLOUD_AGENT_RESOURCE_TAG]: VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
          [VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG]: input.operationId,
          [VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG]: input.runtimeBuildId,
        },
      }),
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, sandboxEnvelopeSchema, operation);
    this.correlateCreateEnvelope(envelope, input, operation);
    return this.withRuntime(envelope);
  }

  async inspectByName(
    input: Omit<CreateSandboxInput, 'timeoutMs'>
  ): Promise<VercelSandboxCreateEnvelope | null> {
    const operation = 'inspect';
    const projectId = this.requireProjectConfiguration(operation);
    requireSandboxName(input.name, operation);
    requireIdentifier(input.operationId, operation);
    requireIdentifier(input.runtimeBuildId, operation);
    requireIdentifier(input.snapshotId, operation);
    if (!runtimeSchema.safeParse(input.runtime).success) {
      throw new VercelSandboxRestError('invalid_request', operation);
    }
    const url = this.namedSandboxUrl(input.name, projectId);
    url.searchParams.set('resume', 'false');
    const response = await this.fetchProvider(operation, url, { method: 'GET' });
    if (response.status === 404) return null;
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, inspectedSandboxEnvelopeSchema, operation);
    this.correlateCreateEnvelope(envelope, input, operation);
    return this.withRuntime(envelope);
  }

  async getSession(
    sessionId: string,
    expectedSandboxName: string
  ): Promise<{ session: VercelSandboxSession; routes: VercelSandboxRoute[] }> {
    const operation = 'get-session';
    this.validateSessionTarget(sessionId, expectedSandboxName, operation);
    const response = await this.fetchProvider(operation, this.sessionUrl(sessionId), {
      method: 'GET',
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, sessionAndRoutesEnvelopeSchema, operation);
    correlateSession(envelope.session, sessionId, expectedSandboxName, operation);
    return envelope;
  }

  async executeCommand(
    sessionId: string,
    input: ExecuteCommandInput & { wait: true }
  ): Promise<WaitedCommandResult>;
  async executeCommand(
    sessionId: string,
    input: ExecuteCommandInput & { wait: false }
  ): Promise<VercelSandboxCommand>;
  async executeCommand(
    sessionId: string,
    input: ExecuteCommandInput
  ): Promise<VercelSandboxCommand | WaitedCommandResult> {
    const operation = 'execute-command';
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    requireIdentifier(input.command, operation);
    if (input.timeoutMs !== undefined) requirePositiveDuration(input.timeoutMs, operation);
    const response = await this.fetchProvider(
      operation,
      this.commandsUrl(sessionId),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          sudo: input.sudo,
          ...(input.wait ? { wait: true } : {}),
          timeout: input.timeoutMs,
        }),
      },
      input.wait ? this.waitedCommandDeadlineMs(input.timeoutMs) : undefined
    );
    await this.requireSuccessfulResponse(response, operation);
    if (input.wait) return this.parseWaitedCommand(response, sessionId, operation);
    const envelope = await this.parseJson(response, commandEnvelopeSchema, operation);
    correlateCommand(envelope.command, sessionId, undefined, operation);
    return envelope.command;
  }

  async listCommands(sessionId: string): Promise<VercelSandboxCommand[]> {
    const operation = 'list-commands';
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    const response = await this.fetchProvider(operation, this.commandsUrl(sessionId), {
      method: 'GET',
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, commandsEnvelopeSchema, operation);
    for (const command of envelope.commands) {
      correlateCommand(command, sessionId, undefined, operation);
    }
    return envelope.commands;
  }

  async getCommand(sessionId: string, commandId: string): Promise<VercelSandboxCommand> {
    const operation = 'get-command';
    this.validateCommandTarget(sessionId, commandId, operation);
    const response = await this.fetchProvider(operation, this.commandUrl(sessionId, commandId), {
      method: 'GET',
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, commandEnvelopeSchema, operation);
    correlateCommand(envelope.command, sessionId, commandId, operation);
    return envelope.command;
  }

  async killCommand(
    sessionId: string,
    commandId: string,
    signal: number
  ): Promise<VercelSandboxCommand> {
    const operation = 'kill-command';
    this.validateCommandTarget(sessionId, commandId, operation);
    if (!Number.isInteger(signal) || signal < 1 || signal > 64) {
      throw new VercelSandboxRestError('invalid_request', operation);
    }
    const url = new URL(
      `${this.commandUrl(sessionId, commandId).pathname}/kill`,
      VERCEL_SANDBOX_API_BASE_URL
    );
    url.searchParams.set('teamId', this.config.teamId);
    const response = await this.fetchProvider(operation, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal }),
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, commandEnvelopeSchema, operation);
    correlateCommand(envelope.command, sessionId, commandId, operation);
    return envelope.command;
  }

  async writeFiles(sessionId: string, cwd: string, files: VercelSandboxFile[]): Promise<void> {
    const operation = 'write-files';
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    if (!cwd.startsWith('/') || files.length === 0) {
      throw new VercelSandboxRestError('invalid_request', operation);
    }
    const response = await this.fetchProvider(operation, this.fileActionUrl(sessionId, 'write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'x-cwd': cwd },
      body: await createGzipTar(files),
    });
    await this.requireSuccessfulResponse(response, operation);
    await response.body?.cancel().catch(() => undefined);
  }

  async readFile(sessionId: string, path: string, maxBytes: number): Promise<Uint8Array> {
    const operation = 'read-file';
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    if (!path.startsWith('/') || !Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new VercelSandboxRestError('invalid_request', operation);
    }
    const response = await this.fetchProvider(operation, this.fileActionUrl(sessionId, 'read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    await this.requireSuccessfulResponse(response, operation);
    return this.readBoundedBytes(response, maxBytes, operation);
  }

  async extendSessionTimeout(
    sessionId: string,
    expectedSandboxName: string,
    durationMs: number
  ): Promise<VercelSandboxSession> {
    const operation = 'extend-timeout';
    this.validateSessionTarget(sessionId, expectedSandboxName, operation);
    requirePositiveDuration(durationMs, operation);
    const response = await this.fetchProvider(
      operation,
      this.sessionActionUrl(sessionId, 'extend-timeout'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: durationMs }),
      }
    );
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, sessionEnvelopeSchema, operation);
    correlateSession(envelope.session, sessionId, expectedSandboxName, operation);
    return envelope.session;
  }

  async stopSession(sessionId: string, expectedSandboxName: string): Promise<VercelSandboxSession> {
    const operation = 'stop-session';
    this.validateSessionTarget(sessionId, expectedSandboxName, operation);
    const response = await this.fetchProvider(operation, this.sessionActionUrl(sessionId, 'stop'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await this.requireSuccessfulResponse(response, operation);
    const envelope = await this.parseJson(response, sessionEnvelopeSchema, operation);
    correlateSession(envelope.session, sessionId, expectedSandboxName, operation);
    return envelope.session;
  }

  private correlateCreateEnvelope(
    envelope: z.infer<typeof sandboxEnvelopeSchema>,
    input: Omit<CreateSandboxInput, 'timeoutMs'>,
    operation: VercelSandboxOperation
  ): void {
    const tags = envelope.sandbox.tags;
    if (
      envelope.sandbox.name !== input.name ||
      envelope.sandbox.persistent ||
      envelope.sandbox.currentSessionId !== envelope.session.id ||
      envelope.session.sourceSandboxName !== input.name ||
      envelope.session.projectId !== this.config.projectId ||
      envelope.session.sourceSnapshotId !== input.snapshotId ||
      envelope.session.runtime !== input.runtime ||
      tags[VERCEL_CLOUD_AGENT_RESOURCE_TAG] !== VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE ||
      tags[VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG] !== input.operationId ||
      tags[VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG] !== input.runtimeBuildId
    ) {
      throw new VercelSandboxRestError('correlation_mismatch', operation);
    }
  }

  private withRuntime(
    envelope: z.infer<typeof sandboxEnvelopeSchema>
  ): VercelSandboxCreateEnvelope {
    return {
      ...envelope,
      runtime: { sandboxName: envelope.sandbox.name, sessionId: envelope.session.id },
    };
  }

  private validateConfiguration(operation: VercelSandboxOperation): void {
    requireValue(this.config.accessToken, operation);
    requireValue(this.config.teamId, operation);
  }

  private requireProjectConfiguration(operation: VercelSandboxOperation): string {
    this.validateConfiguration(operation);
    const projectId = this.config.projectId;
    if (!projectId) throw new VercelSandboxRestError('invalid_configuration', operation);
    return projectId;
  }

  private validateSessionTarget(
    sessionId: string,
    sandboxName: string,
    operation: VercelSandboxOperation
  ): void {
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    requireSandboxName(sandboxName, operation);
  }

  private validateCommandTarget(
    sessionId: string,
    commandId: string,
    operation: VercelSandboxOperation
  ): void {
    this.validateConfiguration(operation);
    requireIdentifier(sessionId, operation);
    requireIdentifier(commandId, operation);
  }

  private collectionUrl(): URL {
    const url = new URL('/v2/sandboxes', VERCEL_SANDBOX_API_BASE_URL);
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private namedSandboxUrl(name: string, projectId: string): URL {
    const url = new URL(`/v2/sandboxes/${encodeURIComponent(name)}`, VERCEL_SANDBOX_API_BASE_URL);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private sessionUrl(sessionId: string): URL {
    const url = new URL(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}`,
      VERCEL_SANDBOX_API_BASE_URL
    );
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private commandsUrl(sessionId: string): URL {
    const url = new URL(`${this.sessionUrl(sessionId).pathname}/cmd`, VERCEL_SANDBOX_API_BASE_URL);
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private commandUrl(sessionId: string, commandId: string): URL {
    const url = new URL(
      `${this.commandsUrl(sessionId).pathname}/${encodeURIComponent(commandId)}`,
      VERCEL_SANDBOX_API_BASE_URL
    );
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private sessionActionUrl(sessionId: string, action: string): URL {
    const url = new URL(
      `${this.sessionUrl(sessionId).pathname}/${action}`,
      VERCEL_SANDBOX_API_BASE_URL
    );
    url.searchParams.set('teamId', this.config.teamId);
    return url;
  }

  private fileActionUrl(sessionId: string, action: 'read' | 'write'): URL {
    return this.sessionActionUrl(sessionId, `fs/${action}`);
  }

  private requestDeadlineMs(operation: VercelSandboxOperation): number {
    switch (operation) {
      case 'create':
      case 'execute-command':
      case 'write-files':
      case 'read-file':
        return STANDARD_REQUEST_DEADLINE_MS;
      default:
        return OBSERVATION_CONTROL_DEADLINE_MS;
    }
  }

  private waitedCommandDeadlineMs(commandTimeoutMs: number | undefined): number {
    if (commandTimeoutMs === undefined) return STANDARD_REQUEST_DEADLINE_MS;
    return Math.min(
      commandTimeoutMs + WAITED_COMMAND_TRANSPORT_ALLOWANCE_MS,
      MAX_PROVIDER_REQUEST_DEADLINE_MS
    );
  }

  private async fetchProvider(
    operation: VercelSandboxOperation,
    url: URL,
    init: RequestInit,
    deadlineMs = this.requestDeadlineMs(operation)
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.config.accessToken}`);
    const deadlineSignal = AbortSignal.timeout(deadlineMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadlineSignal]) : deadlineSignal;
    try {
      const fetchImpl = this.config.fetch;
      const response = await fetchImpl(url.toString(), { ...init, headers, signal });
      this.responseSignals.set(response, signal);
      return response;
    } catch {
      throw new VercelSandboxRestError('request_failed', operation);
    }
  }

  private async requireSuccessfulResponse(
    response: Response,
    operation: VercelSandboxOperation
  ): Promise<void> {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new VercelSandboxRestError('request_failed', operation, response.status);
    }
  }

  private async parseJson<T>(
    response: Response,
    schema: z.ZodType<T>,
    operation: VercelSandboxOperation
  ): Promise<T> {
    const text = await this.readBoundedText(response, MAX_JSON_RESPONSE_BYTES, operation);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VercelSandboxRestError('invalid_response', operation);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new VercelSandboxRestError('invalid_response', operation);
    return parsed.data;
  }

  private async parseWaitedCommand(
    response: Response,
    sessionId: string,
    operation: VercelSandboxOperation
  ): Promise<WaitedCommandResult> {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim();
    if (contentType !== 'application/x-ndjson') {
      throw new VercelSandboxRestError('invalid_response', operation);
    }
    const text = await this.readBoundedText(response, MAX_NDJSON_RESPONSE_BYTES, operation);
    const lines = text.split('\n').filter(line => line.length > 0);
    if (
      lines.length !== MAX_NDJSON_LINES ||
      lines.some(line => new TextEncoder().encode(line).byteLength > MAX_NDJSON_LINE_BYTES)
    ) {
      throw new VercelSandboxRestError('invalid_response', operation);
    }
    let startedBody: unknown;
    let finishedBody: unknown;
    try {
      startedBody = JSON.parse(lines[0]);
      finishedBody = JSON.parse(lines[1]);
    } catch {
      throw new VercelSandboxRestError('invalid_response', operation);
    }
    const started = commandEnvelopeSchema.safeParse(startedBody);
    const finished = finishedCommandEnvelopeSchema.safeParse(finishedBody);
    if (!started.success || !finished.success) {
      throw new VercelSandboxRestError('invalid_response', operation);
    }
    correlateCommand(started.data.command, sessionId, undefined, operation);
    correlateCommand(finished.data.command, sessionId, started.data.command.id, operation);
    return { command: started.data.command, finished: finished.data.command };
  }

  private async readBoundedText(
    response: Response,
    maxBytes: number,
    operation: VercelSandboxOperation
  ): Promise<string> {
    return new TextDecoder().decode(await this.readBoundedBytes(response, maxBytes, operation));
  }

  private async readBoundedBytes(
    response: Response,
    maxBytes: number,
    operation: VercelSandboxOperation
  ): Promise<Uint8Array> {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new VercelSandboxRestError('response_too_large', operation);
    }
    if (response.body === null) throw new VercelSandboxRestError('invalid_response', operation);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    try {
      while (true) {
        const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (chunk.done) break;
        bytesRead += chunk.value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new VercelSandboxRestError('response_too_large', operation);
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(bytesRead);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (error instanceof VercelSandboxRestError) throw error;
      if (this.responseSignals.get(response)?.aborted) {
        throw new VercelSandboxRestError('request_failed', operation);
      }
      throw new VercelSandboxRestError('invalid_response', operation);
    } finally {
      reader.releaseLock();
    }
  }
}
