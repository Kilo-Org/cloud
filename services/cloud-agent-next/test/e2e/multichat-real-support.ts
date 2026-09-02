import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { z } from 'zod';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const MODEL = 'kilo-auto/efficient';
export class CheckError extends Error {}
export class RpcHttpError extends CheckError {
  readonly status: number;

  constructor(procedure: string, status: number) {
    super(`${procedure}: HTTP ${status}; inspect private evidence`);
    this.status = status;
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

export function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  check(result.success, `${label}: invalid response shape`);
  return result.data;
}

export const sessionSchema = z.object({
  cloudAgentSessionId: z.string().regex(/^workspace_[0-9a-f-]{36}$/),
  kiloSessionId: z.string().regex(/^ses_[A-Za-z0-9]{26}$/),
  worktreeId: z.string().optional(),
});
export type Chat = z.infer<typeof sessionSchema> & { label: string };

export const messageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(['user', 'assistant']),
  parentID: z.string().optional(),
  error: z.object({ name: z.string() }).optional(),
  finish: z.string().optional(),
  time: z.object({ completed: z.number().optional() }).optional(),
});
export const partSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  type: z.string(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  tool: z.string().optional(),
  callID: z.string().optional(),
  state: z
    .object({
      status: z.string(),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.string().optional(),
      error: z.string().optional(),
      metadata: z.object({ exit: z.number().nullable().optional() }).optional(),
      time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
    })
    .optional(),
});
export type Part = z.infer<typeof partSchema>;
export type NativeTurn = { messages: z.infer<typeof messageSchema>[]; tools: Part[] };
export type NativeHold = {
  partId: string;
  callId: string;
  messageId: string;
  startedAt: number;
  seconds: number;
};

export function runningNativeHold(parts: Part[], seconds: number): NativeHold | undefined {
  const part = parts.find(
    value =>
      value.type === 'tool' &&
      value.tool === 'bash' &&
      value.state?.status === 'running' &&
      value.state.input?.command === `sleep ${seconds}` &&
      value.state.time?.end === undefined
  );
  if (!part?.callID || part.state?.time?.start === undefined) return undefined;
  return {
    partId: part.id,
    callId: part.callID,
    messageId: part.messageID,
    startedAt: part.state.time.start,
    seconds,
  };
}

export function matchesNativeHold(part: Part, hold: NativeHold): boolean {
  return (
    part.type === 'tool' &&
    part.tool === 'bash' &&
    part.id === hold.partId &&
    part.callID === hold.callId &&
    part.messageID === hold.messageId &&
    part.state?.input?.command === `sleep ${hold.seconds}` &&
    part.state.time?.start === hold.startedAt
  );
}

export function assertNativeHoldOverlap(parts: Part[]) {
  check(parts.length >= 2, 'Native overlap requires multiple holds');
  const windows = parts.map(part => {
    const time = part.state?.time;
    check(
      part.state?.status === 'completed' && time?.end !== undefined && time.end > time.start,
      'Native overlap requires completed tool intervals'
    );
    return { start: time.start, end: time.end };
  });
  const start = Math.max(...windows.map(window => window.start));
  const end = Math.min(...windows.map(window => window.end));
  check(end - start >= 1000, 'Native hold intervals did not overlap for at least one second');
  return { start, end, overlapMs: end - start };
}

function isAbortedShellResult(part: Part, hold: NativeHold): boolean {
  return (
    matchesNativeHold(part, hold) &&
    part.state?.status === 'completed' &&
    part.state.metadata?.exit === null &&
    /<shell_metadata>\s*User aborted the command\s*<\/shell_metadata>\s*$/.test(
      part.state.output ?? ''
    ) &&
    part.state.time?.end !== undefined &&
    part.state.time.end >= hold.startedAt &&
    part.state.time.end < hold.startedAt + hold.seconds * 1000
  );
}

export function assertNoNativeCompletion(turn: NativeTurn, hold: NativeHold) {
  check(
    !turn.tools.some(
      part =>
        matchesNativeHold(part, hold) &&
        part.state?.status === 'completed' &&
        !isAbortedShellResult(part, hold)
    ),
    'Stopped native hold completed successfully'
  );
  check(
    !turn.messages.some(
      message =>
        message.role === 'assistant' &&
        !message.error &&
        message.finish &&
        !['tool-calls', 'tool_calls', 'tool_use'].includes(message.finish)
    ),
    'Stopped turn emitted an error-free final finish'
  );
}

export function hasNativeCancellation(turn: NativeTurn, hold: NativeHold): boolean {
  assertNoNativeCompletion(turn, hold);
  const aborted = turn.messages.some(
    message => message.id === hold.messageId && message.error?.name === 'MessageAbortedError'
  );
  return turn.tools.some(
    part =>
      matchesNativeHold(part, hold) &&
      part.state?.time?.end !== undefined &&
      part.state.time.end >= hold.startedAt &&
      ((part.state.status === 'error' &&
        Boolean(part.state.error) &&
        (/abort|cancel|interrupt/i.test(part.state.error ?? '') || aborted)) ||
        (isAbortedShellResult(part, hold) && aborted))
  );
}

export async function until<T>(
  label: string,
  timeoutMs: number,
  signal: AbortSignal,
  action: (remainingMs: number) => Promise<T | undefined>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check(!signal.aborted, 'Run deadline or operator interruption; no mutations retried');
    const value = await action(deadline - Date.now());
    if (value !== undefined) return value;
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new CheckError(`${label}: timed out; inspect evidence, do not resend ambiguous mutations`);
}

export function setup(authPath: string, outPath: string) {
  const authFile = resolve(ROOT, authPath);
  check(realpathSync(dirname(authFile)) === dirname(authFile), 'Auth parent must not be symlinked');
  const fd = openSync(authFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let auth;
  try {
    const stat = fstatSync(fd);
    check(
      stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid?.(),
      'Auth must be an owned regular mode-600 file'
    );
    auth = parse(
      z.object({ token: z.string().min(1), userId: z.string().min(1) }).strict(),
      JSON.parse(readFileSync(fd, 'utf8')),
      'Auth'
    );
  } finally {
    closeSync(fd);
  }
  const localVars = parseEnv(
    readFileSync(resolve(ROOT, 'services/cloud-agent-next/.dev.vars'), 'utf8')
  );
  const devVars = parse(
    z.object({ NEXTAUTH_SECRET: z.string().min(1), INTERNAL_API_SECRET: z.string().min(1) }),
    localVars,
    'Worker local secrets'
  );
  const secrets = [
    auth.token,
    ...Object.values(localVars).filter(
      (value): value is string => typeof value === 'string' && value.length >= 8
    ),
  ];
  function scrub(value: unknown): unknown {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      return text
        .replace(
          /<environment_details>[\s\S]*?(?:<\/environment_details>|$)/gi,
          '[environment omitted]'
        )
        .replace(
          /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
          '[redacted]'
        )
        .replace(/\b(?:https?|wss?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, '[url omitted]')
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, '[redacted]')
        .replace(/\b(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(
          /^\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=[^\r\n]*/gm,
          '[environment assignment omitted]'
        )
        .replace(
          /\b(?:credential\w*|token|secret|authorization|(?:set-)?cookie|password|api[_-]?key)\s*[=:]\s*[^\r\n]*/gi,
          '[redacted]'
        );
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          /credential|token|secret|authorization|cookie|password|api.?key|private.?key|ticket|headers|streamUrl|^env|^delta$/i.test(
            key
          )
            ? '[redacted]'
            : scrub(item),
        ])
      );
    }
    return value;
  }
  const out = resolve(ROOT, outPath);
  const parent = resolve(ROOT, 'dev/logs');
  check(
    dirname(out) === parent && realpathSync(parent) === parent,
    '--out must be a NEW direct child of this worktree dev/logs'
  );
  execFileSync('git', ['check-ignore', '-q', `${relative(ROOT, out)}/report.json`], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  mkdirSync(out, { mode: 0o700 });
  check((lstatSync(out).mode & 0o777) === 0o700, 'Evidence directory must be private');
  function save(name: string, value: unknown) {
    const temporary = resolve(out, `${name}.tmp`);
    writeFileSync(temporary, JSON.stringify(scrub(value), null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, resolve(out, name));
  }
  function record(name: string, value: unknown) {
    const file = openSync(
      resolve(out, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600
    );
    try {
      writeFileSync(file, `${JSON.stringify(scrub({ at: Date.now(), value }))}\n`);
    } finally {
      closeSync(file);
    }
  }
  const status = parse(
    z.object({
      services: z.array(
        z
          .object({
            name: z.string(),
            port: z.number().int().min(1).max(65535),
            status: z.string(),
          })
          .or(z.object({ name: z.string(), port: z.literal(0), status: z.string() }))
      ),
    }),
    JSON.parse(
      execFileSync('pnpm', ['--silent', 'dev:status', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ),
    'dev:status'
  );
  function endpoint(name: string) {
    const matches = status.services.filter(service => service.name === name);
    const service = matches[0];
    check(
      matches.length === 1 && service?.status === 'up' && service.port > 0,
      `Required local service ${name} is not up`
    );
    return `http://127.0.0.1:${service.port}`;
  }
  const base = {
    web: endpoint('nextjs'),
    worker: endpoint('cloud-agent-next'),
    ingest: endpoint('cloudflare-session-ingest'),
  };
  return { auth, devVars, out, save, record, base };
}
export type Runtime = ReturnType<typeof setup> & { signal: AbortSignal };

export function mintBootstrapToken(auth: Runtime['auth'], secret: string): string {
  let verified: unknown;
  try {
    verified = jwt.verify(auth.token, secret, { algorithms: ['HS256'] });
  } catch {
    throw new CheckError(
      'Bootstrap requires an unexpired fixture JWT verified by the local Worker NEXTAUTH_SECRET'
    );
  }
  const claims = parse(
    z
      .object({
        version: z.literal(3),
        kiloUserId: z.string().min(1),
        env: z.enum(['production', 'development']),
        apiTokenPepper: z.string().nullable(),
        tokenSource: z.literal('cloud-agent').optional(),
        iat: z.number().int().nonnegative(),
        exp: z.number().int().nonnegative(),
      })
      .strict(),
    verified,
    'Bootstrap personal fixture JWT (admin, scoped and unknown claims are rejected)'
  );
  const now = Math.floor(Date.now() / 1000);
  check(
    claims.kiloUserId === auth.userId && claims.iat <= now && claims.exp > claims.iat,
    'Bootstrap fixture identity or issuance time mismatch'
  );
  const expiresIn = Math.min(3600, claims.exp - now);
  check(expiresIn >= 45 * 60, 'Bootstrap fixture must remain valid for the full 45-minute run');
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: claims.kiloUserId,
      apiTokenPepper: claims.apiTokenPepper,
      version: claims.version,
      tokenSource: 'cloud-agent',
      iat: now,
    },
    secret,
    { algorithm: 'HS256', expiresIn }
  );
}

export async function rpc(
  runtime: Runtime,
  target: 'web' | 'worker',
  procedure: string,
  input: unknown,
  method: 'GET' | 'POST' = 'POST',
  timeoutMs = method === 'POST' ? 90_000 : 15_000,
  internal = false
): Promise<unknown> {
  check(!runtime.signal.aborted, 'Run stopped before request');
  const url = new URL(`${target === 'web' ? '/api' : ''}/trpc/${procedure}`, runtime.base[target]);
  if (method === 'GET' && input !== undefined) url.searchParams.set('input', JSON.stringify(input));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${runtime.auth.token}`,
    'Content-Type': 'application/json',
  };
  if (internal) {
    check(
      target === 'worker' && procedure === 'prepareSession' && method === 'POST',
      'Trusted bootstrap authentication is restricted to Worker prepareSession'
    );
    headers.Authorization = `Bearer ${mintBootstrapToken(runtime.auth, runtime.devVars.NEXTAUTH_SECRET)}`;
    headers['x-internal-api-key'] = runtime.devVars.INTERNAL_API_SECRET;
  }
  const requestId = randomUUID();
  if (method === 'POST')
    runtime.record('mutations.jsonl', { requestId, target, procedure, input, status: 'intent' });
  let response;
  let body: unknown;
  try {
    response = await fetch(url, {
      method,
      headers,
      redirect: 'error',
      body: method === 'POST' ? JSON.stringify(input) : undefined,
      signal: AbortSignal.any([runtime.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
    });
    body = await response.json();
  } catch {
    throw new CheckError(
      `${procedure}: transport failure or deadline; mutation outcome may be ambiguous, never retried`
    );
  }
  runtime.record(method === 'POST' ? 'mutations.jsonl' : 'queries.jsonl', {
    requestId,
    procedure,
    httpStatus: response.status,
    response: body,
  });
  if (!response.ok) throw new RpcHttpError(procedure, response.status);
  return parse(z.object({ result: z.object({ data: z.unknown() }) }), body, procedure).result.data;
}

export async function observe(runtime: Runtime, chat: Chat) {
  const ticket = jwt.sign(
    {
      type: 'stream_ticket',
      purpose: 'stream',
      userId: runtime.auth.userId,
      cloudAgentSessionId: chat.cloudAgentSessionId,
      kiloSessionId: chat.kiloSessionId,
      nonce: randomUUID(),
    },
    runtime.devVars.NEXTAUTH_SECRET,
    { algorithm: 'HS256', expiresIn: 600, audience: 'cloud-agent-stream' }
  );
  const url = new URL('/stream', runtime.base.worker.replace('http:', 'ws:'));
  url.searchParams.set('cloudAgentSessionId', chat.cloudAgentSessionId);
  url.searchParams.set('ticket', ticket);
  const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 4 * 1024 * 1024 });
  const messages = new Map<string, z.infer<typeof messageSchema>>();
  const parts = new Map<string, Part>();
  const messageEvents: { sequence: number; info: z.infer<typeof messageSchema> }[] = [];
  const toolEvents: { sequence: number; part: Part }[] = [];
  const terminals = new Map<string, { type: string; status?: string; at: number }>();
  let connected = false;
  let failure: string | undefined;
  let closed = false;
  let count = 0;
  const stop = () => {
    closed = true;
    ws.terminate();
  };
  runtime.signal.addEventListener('abort', stop, { once: true });
  ws.on('error', () => {
    failure = 'stream transport error';
  });
  ws.on('close', () => {
    if (!closed) failure = 'stream closed unexpectedly';
  });
  ws.on('message', raw => {
    try {
      check(++count <= 100_000, 'stream event limit exceeded');
      const buffer = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      const event: unknown = JSON.parse(buffer.toString('utf8'));
      const envelope = parse(
        z.object({
          streamEventType: z.string().optional(),
          type: z.string().optional(),
          sessionId: z.string().optional(),
          data: z.unknown().optional(),
        }),
        event,
        'Stream envelope'
      );
      check(
        !envelope.sessionId || envelope.sessionId === chat.cloudAgentSessionId,
        'foreign cloud session on stream'
      );
      const type = envelope.streamEventType ?? envelope.type;
      if (type !== 'kilocode')
        runtime.record(`${chat.label}-events.jsonl`, { sequence: count, event });
      if (type === 'connected') connected = true;
      if (type === 'cloud.message.completed' || type === 'cloud.message.failed') {
        const data = parse(
          z.object({ messageId: z.string(), status: z.string().optional() }),
          envelope.data,
          'Terminal event'
        );
        const previous = terminals.get(data.messageId);
        check(
          !previous || (previous.type === type && previous.status === data.status),
          'conflicting terminal events for one message'
        );
        terminals.set(data.messageId, { type, status: data.status, at: Date.now() });
      }
      if (type !== 'kilocode') return;
      const data = parse(
        z.object({
          type: z.string().optional(),
          event: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
        }),
        envelope.data,
        'Kilo event'
      );
      const eventType = data.type ?? data.event;
      if (eventType === 'message.part.delta') return;
      runtime.record(`${chat.label}-events.jsonl`, { sequence: count, event });
      if (eventType === 'message.updated') {
        const info = parse(messageSchema, data.properties?.info, 'Stream message');
        check(info.sessionID === chat.kiloSessionId, 'foreign Kilo message on stream');
        messages.set(info.id, info);
        if (info.finish || info.error) messageEvents.push({ sequence: count, info });
      }
      if (eventType === 'message.part.updated') {
        const part = parse(partSchema, data.properties?.part, 'Stream part');
        check(part.sessionID === chat.kiloSessionId, 'foreign Kilo part on stream');
        parts.set(part.id, part);
        if (part.type === 'tool' && ['completed', 'error'].includes(part.state?.status ?? '')) {
          toolEvents.push({ sequence: count, part });
        }
      }
    } catch (error) {
      failure =
        error instanceof CheckError
          ? error.message
          : 'invalid stream frame or evidence write failure';
      ws.terminate();
    }
  });
  function healthy() {
    check(!failure && !closed, `${chat.label}: ${failure ?? 'observer stopped'}`);
  }
  try {
    await until(`${chat.label} stream readiness`, 15_000, runtime.signal, async () => {
      healthy();
      return connected ? true : undefined;
    });
  } catch (error) {
    stop();
    runtime.signal.removeEventListener('abort', stop);
    throw error;
  }
  return {
    healthy,
    terminals,
    sequence: () => count,
    nativeEvents(messageId: string, afterSequence = 0): NativeTurn {
      healthy();
      return {
        messages: messageEvents
          .filter(event => event.sequence > afterSequence && event.info.parentID === messageId)
          .map(event => event.info),
        tools: toolEvents
          .filter(
            event =>
              event.sequence > afterSequence &&
              messages.get(event.part.messageID)?.parentID === messageId
          )
          .map(event => event.part),
      };
    },
    tools(messageId: string) {
      healthy();
      return [...parts.values()].filter(
        part => part.type === 'tool' && messages.get(part.messageID)?.parentID === messageId
      );
    },
    close() {
      runtime.signal.removeEventListener('abort', stop);
      stop();
    },
  };
}
export type Observer = Awaited<ReturnType<typeof observe>>;
