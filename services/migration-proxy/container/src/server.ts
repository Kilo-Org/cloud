import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { startApply, type ApplyRequest, type RunHandle } from './apply.ts';
import {
  ProbeError,
  SESSION_LABEL_PREFIX,
  actAsLogin,
  connect,
  countSessions,
  ownPair,
  sqlstateOf,
  type Login,
} from './session.ts';

/**
 * The proxy's container (contract §1, §6): one run or one sample per container lifetime, driven
 * by the Durable Object over its TCP port. It makes no HTTP(S) call of its own. Logs are one JSON
 * line per event, with codes only: never a request body, password, user, target or SQL text.
 */

const PORT = 8080;
/** The journal plus every migration file is about 0.8 MB today; this leaves years of room. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** §6 step 9: how long SIGTERM waits for a cancelled statement before exiting. */
const SIGTERM_GRACE_MS = 10_000;

type Log = (event: Record<string, string | number | null>) => void;
const log: Log = event => console.log(JSON.stringify(event));

let run: RunHandle | null = null;
let sampling = false;

const PairSchema = z.strictObject({ pid: z.number().int(), backendStart: z.string() });

const LoginSchema = z.object({
  target: z.strictObject({ host: z.string().min(1), port: z.literal(5432), database: z.string() }),
  user: z.string().min(1),
  password: z.string(),
  loginMode: z.enum(['member', 'direct']),
  sessionKey: z.enum(['label', 'pid']),
  recordedPairs: z.array(PairSchema),
});

const ApplySchema = LoginSchema.extend({
  runId: z.string().min(1),
  journal: z.string(),
  files: z.record(z.string(), z.string()),
  reviewed: z.array(z.strictObject({ path: z.string(), blob: z.string() })),
}).strict();

const SampleSchema = LoginSchema.extend({ sampleId: z.string().min(1) }).strict();

function loginOf(body: z.infer<typeof LoginSchema>): Login {
  const { target, user, password, loginMode, sessionKey } = body;
  return { target, user, password, loginMode, sessionKey };
}

/**
 * §3 sampled check: connects as the login with the sample's label, reports its own pair, counts
 * the other sessions of the login against the recorded pairs, and disconnects.
 */
async function sample(body: z.infer<typeof SampleSchema>) {
  const login = loginOf(body);
  const { sampleId, recordedPairs: pairs } = body;
  body.password = '';
  let client;
  try {
    client = await connect(login, `${SESSION_LABEL_PREFIX}sample:${sampleId}`);
  } catch (error) {
    const reason = error instanceof ProbeError ? error.reason : 'connect_timeout';
    log({ event: 'sample_failed', sampleId, reason, sqlstate: null });
    return { result: 'failed', reason, pair: null, unexpected: 0, leftover: 0 };
  } finally {
    login.password = '';
  }
  try {
    const pair = await ownPair(client);
    await actAsLogin(client, login);
    const counts = await countSessions(client, login, pairs);
    log({ event: 'sample_done', sampleId, ...counts });
    return { result: 'ok', reason: null, pair, ...counts };
  } catch (error) {
    const reason = error instanceof ProbeError ? error.reason : 'query_failed';
    log({ event: 'sample_failed', sampleId, reason, sqlstate: sqlstateOf(error) });
    return { result: 'failed', reason, pair: null, unexpected: 0, leftover: 0 };
  } finally {
    await client.end().catch(() => {});
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new SyntaxError('body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://container').pathname;
  const route = `${request.method ?? 'GET'} ${path}`;
  switch (route) {
    case 'GET /health':
      return reply(response, 200, { ok: true });
    case 'POST /apply': {
      const parsed = ApplySchema.parse(await readBody(request));
      const body: ApplyRequest = { ...loginOf(parsed), ...parsed };
      parsed.password = '';
      if (run !== null) {
        return reply(response, run.runId === body.runId ? 202 : 409, { runId: run.runId });
      }
      if (sampling) return reply(response, 409, { runId: null });
      run = startApply(body, log);
      log({ event: 'apply_accepted', runId: body.runId });
      return reply(response, 202, { runId: body.runId });
    }
    case 'GET /status':
      return run === null
        ? reply(response, 404, { status: 'no_run' })
        : reply(response, 200, run.status());
    case 'POST /cancel':
      if (run !== null) {
        await run.cancel();
        log({ event: 'cancel_sent', runId: run.runId });
      }
      return reply(response, 202, { ok: true });
    case 'POST /sample': {
      if (run !== null || sampling) return reply(response, 409, { status: 'busy' });
      sampling = true;
      try {
        return reply(response, 200, await sample(SampleSchema.parse(await readBody(request))));
      } finally {
        sampling = false;
      }
    }
    default:
      return reply(response, 404, { status: 'not_found' });
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (!response.headersSent) {
      reply(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, {
        status: 'error',
      });
    }
  });
});
server.listen(PORT);
log({ event: 'listening', port: PORT });

process.on('SIGTERM', () => {
  log({ event: 'sigterm', runId: run?.runId ?? null });
  const current = run;
  if (current === null) process.exit(0);
  void current.cancel().finally(() => {
    const timer = setTimeout(() => process.exit(0), SIGTERM_GRACE_MS);
    void current.done.finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  });
});
