import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NEXTAUTH_SECRET, NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getTrustedSignupClientIp } from '@/lib/auth/trusted-signup-ip';

const SESSION_COOKIE = 'watchwood_signup_session';
const MAX_AGE_SECONDS = 60 * 60;
const TOKEN_TTL_SECONDS = 10 * 60;
const DEADLINE_MS = 1000;
const MAX_BODY_BYTES = 16 * 1024;
const CREATE_ACCOUNT_URL = 'https://api.openai.com/v1/watchwood/check/create_account';
const incrementBudget = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;
const identitySchema = z.object({ safetyIdentifier: z.uuid() });
const turnstileSchema = z.object({ guid: z.uuid(), ip: z.string() });
const riskReasonsSchema = z.array(z.string().trim().min(1).max(64)).max(10);
const tokenRecordSchema = z.object({
  token: z.string().max(8192),
  ip: z.string(),
  turnstileGuid: z.uuid(),
  receivedAt: z.number().int().nonnegative(),
  status: z.enum(['pending', 'token_missing', 'rate_limited']),
});
const assessmentBase = z.object({
  safetyIdentifier: z.uuid().optional(),
  latencyMs: z.number().finite().nonnegative(),
  assessedAt: z.number().int().nonnegative(),
});
const assessmentSchema = z.discriminatedUnion('status', [
  assessmentBase.extend({
    status: z.literal('assessed'),
    riskScore: z.number().finite().min(0).max(1),
    riskReasons: riskReasonsSchema.optional(),
    riskSubReasons: riskReasonsSchema.optional(),
  }),
  assessmentBase.extend({
    status: z.enum([
      'missing',
      'token_missing',
      'invalid_context',
      'rate_limited',
      'unavailable',
      'invalid_response',
      'upstream_error',
    ]),
    upstreamStatus: z.number().int().nonnegative().optional(),
  }),
]);
const upstreamSchema = z.object({
  risk_score: z.number().finite().min(0).max(1),
  risk_reasons: z.unknown().optional(),
  risk_sub_reasons: z.unknown().optional(),
});
const submissionSchema = z.object({
  token: z.string().max(8192).default(''),
  safety_identifier: z.uuid(),
});

export type WatchwoodSignupAssessment = z.infer<typeof assessmentSchema>;
export type WatchwoodSignupContext =
  | { safetyIdentifier: string; turnstileGuid: string }
  | { status: 'missing' | 'invalid_context' | 'unavailable' };
type WatchwoodTokenStatus = z.infer<typeof tokenRecordSchema>['status'];

type WatchwoodTokenRecord = z.infer<typeof tokenRecordSchema>;

function config() {
  const orgId = process.env.WATCHWOOD_ORG_ID?.trim();
  const apiKey = process.env.WATCHWOOD_API_KEY?.trim();
  return process.env.WATCHWOOD_SHADOW_ENABLED === 'true' && orgId && apiKey
    ? { orgId, apiKey }
    : undefined;
}

function cookieOptions() {
  const secure = NEXTAUTH_URL?.startsWith('https://') ?? false;
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? ('none' as const) : ('lax' as const),
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

function sign(value: object, audience: string) {
  return jwt.sign(value, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    audience,
    expiresIn: MAX_AGE_SECONDS,
  });
}

function verify(value: string | undefined, audience?: string): unknown {
  if (!value || value.length > 4096) return undefined;
  try {
    return jwt.verify(value, NEXTAUTH_SECRET, {
      algorithms: ['HS256'],
      ...(audience ? { audience } : {}),
      maxAge: MAX_AGE_SECONDS,
    });
  } catch {
    return undefined;
  }
}

function tokenKey(safetyIdentifier: string) {
  const digest = createHmac('sha256', NEXTAUTH_SECRET).update(safetyIdentifier).digest('hex');
  return `watchwood:signup:token:${digest}`;
}

async function storeToken(
  safetyIdentifier: string,
  record: WatchwoodTokenRecord,
  signal: AbortSignal
): Promise<void> {
  await withinDeadline(
    () =>
      redisClient.set(tokenKey(safetyIdentifier), JSON.stringify(record), {
        ex: TOKEN_TTL_SECONDS,
      }),
    signal
  );
}

async function takeToken(
  safetyIdentifier: string,
  signal: AbortSignal
): Promise<WatchwoodTokenRecord | undefined> {
  const value = await withinDeadline(
    () => redisClient.getdel<string>(tokenKey(safetyIdentifier)),
    signal
  );
  if (!value) return undefined;
  try {
    const parsed = tokenRecordSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function safeAssessment(assessment: WatchwoodSignupAssessment) {
  return {
    status: assessment.status,
    safetyIdentifier: assessment.safetyIdentifier,
    latencyMs: assessment.latencyMs,
    assessedAt: assessment.assessedAt,
    ...(assessment.status === 'assessed'
      ? {
          riskScore: assessment.riskScore,
          ...(assessment.riskReasons ? { riskReasons: assessment.riskReasons } : {}),
          ...(assessment.riskSubReasons ? { riskSubReasons: assessment.riskSubReasons } : {}),
        }
      : {}),
  };
}

export async function readWatchwoodSignupContext(): Promise<WatchwoodSignupContext> {
  if (!config()) return { status: 'missing' };
  try {
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE)?.value;
    const session = identitySchema.safeParse(verify(raw, SESSION_COOKIE));
    const turnstile = turnstileSchema.safeParse(verify(store.get('turnstile_jwt')?.value));
    try {
      store.delete(SESSION_COOKIE);
    } catch {
      // Some authentication callbacks expose read-only cookies.
    }
    if (!raw) return { status: 'missing' };
    if (!session.success || !turnstile.success) return { status: 'invalid_context' };
    return {
      safetyIdentifier: session.data.safetyIdentifier,
      turnstileGuid: turnstile.data.guid,
    };
  } catch {
    return { status: 'unavailable' };
  }
}

export function recordWatchwoodSignupShadow({
  operationId,
  provider,
  assessment,
}: {
  operationId: string;
  provider: string;
  assessment: WatchwoodSignupAssessment | undefined;
}): void {
  if (!assessment) return;
  console.info('[auth] Watchwood signup shadow', {
    operationId,
    provider,
    shadow: true,
    enforced: false,
    ...safeAssessment(assessment),
  });
}

export async function checkWatchwoodSignup({
  operationId,
  context,
  email,
  ip,
}: {
  operationId: string;
  context: WatchwoodSignupContext | undefined;
  email: string;
  ip: string | undefined;
}): Promise<WatchwoodSignupAssessment | undefined> {
  const enabled = config();
  if (!enabled) return undefined;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
  let status: WatchwoodSignupAssessment['status'] = 'invalid_context';
  let safetyIdentifier: string | undefined;
  let tokenAgeMs: number | undefined;
  let riskScore: number | undefined;
  let riskReasons: string[] | undefined;
  let riskSubReasons: string[] | undefined;
  let upstreamStatus: number | undefined;
  let riskReasonsUnrecognized = false;
  try {
    if (!context) {
      status = 'missing';
    } else if ('status' in context) {
      status = context.status;
    } else {
      safetyIdentifier = context.safetyIdentifier;
      const record = await takeToken(context.safetyIdentifier, controller.signal);
      if (!record) {
        status = 'missing';
      } else {
        tokenAgeMs = Date.now() - record.receivedAt;
        if (record.status !== 'pending') {
          status = record.status;
        } else if (!ip || record.ip !== ip || record.turnstileGuid !== context.turnstileGuid) {
          status = 'invalid_context';
        } else if (!record.token) {
          status = 'token_missing';
        } else {
          for (let attempt = 0; attempt < 2; attempt++) {
            controller.signal.throwIfAborted();
            status = 'unavailable';
            const upstream = await fetch(CREATE_ACCOUNT_URL, {
              method: 'POST',
              redirect: 'manual',
              cache: 'no-store',
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${enabled.apiKey}`,
                'Content-Type': 'application/json',
                'X-OpenAI-Watchwood-Token': record.token,
                'X-OpenAI-Watchwood-Client-IP': ip,
              },
              body: JSON.stringify({
                safety_identifier: safetyIdentifier,
                extra_signals: { email: email.trim() },
              }),
            });
            if (upstream.status >= 500 && upstream.status <= 599 && attempt === 0) {
              void upstream.body?.cancel().catch(() => undefined);
              continue;
            }
            if (!upstream.ok) {
              void upstream.body?.cancel().catch(() => undefined);
              status = 'upstream_error';
              upstreamStatus = upstream.status;
              break;
            }
            status = 'invalid_response';
            let body: unknown;
            try {
              body = await readBoundedJson(upstream.body, controller.signal);
            } catch (error) {
              if (controller.signal.aborted) throw error;
              break;
            }
            const parsed = upstreamSchema.safeParse(body);
            if (parsed.success) {
              status = 'assessed';
              riskScore = parsed.data.risk_score;
              const reasons = riskReasonsSchema.safeParse(parsed.data.risk_reasons);
              const subReasons = riskReasonsSchema.safeParse(parsed.data.risk_sub_reasons);
              riskReasonsUnrecognized =
                ('risk_reasons' in parsed.data && !reasons.success) ||
                ('risk_sub_reasons' in parsed.data && !subReasons.success);
              if (reasons.success) riskReasons = reasons.data;
              if (subReasons.success) riskSubReasons = subReasons.data;
            }
            break;
          }
        }
      }
    }
  } catch {
    status = 'unavailable';
  }
  clearTimeout(timeout);
  const base = { safetyIdentifier, latencyMs: Date.now() - startedAt, assessedAt: Date.now() };
  const assessment: WatchwoodSignupAssessment =
    status === 'assessed' && riskScore !== undefined
      ? {
          ...base,
          status: 'assessed',
          riskScore,
          ...(riskReasons ? { riskReasons } : {}),
          ...(riskSubReasons ? { riskSubReasons } : {}),
        }
      : status === 'upstream_error'
        ? {
            ...base,
            status: 'upstream_error',
            ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
          }
        : { ...base, status: status === 'assessed' ? 'invalid_response' : status };
  console.info('[auth] Watchwood signup attempt', {
    operationId,
    shadow: true,
    enforced: false,
    ...safeAssessment(assessment),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    ...(tokenAgeMs !== undefined ? { tokenAgeMs } : {}),
    ...(riskReasonsUnrecognized ? { riskReasonsUnrecognized: true } : {}),
  });
  return assessment;
}

function response() {
  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function prepareWatchwoodSignupSession(request: NextRequest): Promise<NextResponse> {
  const enabled = config();
  if (!enabled)
    return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const existing = identitySchema.safeParse(
      verify(request.cookies.get(SESSION_COOKIE)?.value, SESSION_COOKIE)
    );
    const identity = existing.success ? existing.data : { safetyIdentifier: randomUUID() };
    const result = NextResponse.json(
      { enabled: true, org_id: enabled.orgId, safety_identifier: identity.safetyIdentifier },
      { headers: { 'Cache-Control': 'no-store' } }
    );
    if (!existing.success)
      result.cookies.set(SESSION_COOKIE, sign(identity, SESSION_COOKIE), cookieOptions());
    return result;
  } catch {
    return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

async function readBoundedJson(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): Promise<unknown> {
  if (!body) throw new Error('Missing body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('Body too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function withinDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const value = await Promise.race([operation(), promise]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function rateLimited(guid: string, ip: string, signal: AbortSignal): Promise<boolean> {
  const bucket = Math.floor(Date.now() / (MAX_AGE_SECONDS * 1000));
  for (const [scope, value, limit] of [
    ['turnstile', guid, 3],
    ['ip', ip, 10],
  ] as const) {
    const digest = createHmac('sha256', NEXTAUTH_SECRET).update(value).digest('hex');
    const key = `watchwood:signup:${scope}:${digest}:${bucket}`;
    const count = await withinDeadline(
      () => redisClient.eval<[number], number>(incrementBudget, [key], [MAX_AGE_SECONDS * 2]),
      signal
    );
    if (count > limit) return true;
  }
  return false;
}

export async function assessWatchwoodSignup(request: NextRequest): Promise<NextResponse> {
  const enabled = config();
  const result = response();
  if (!enabled) return result;
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
  let safetyIdentifier: string | undefined;
  let turnstileGuid: string | undefined;
  let status: WatchwoodTokenStatus | 'invalid_context' | 'unavailable' = 'invalid_context';
  try {
    const session = identitySchema.safeParse(
      verify(request.cookies.get(SESSION_COOKIE)?.value, SESSION_COOKIE)
    );
    const turnstile = turnstileSchema.safeParse(
      verify(request.cookies.get('turnstile_jwt')?.value)
    );
    const ip = getTrustedSignupClientIp(request.headers);
    if (!session.success || !turnstile.success || !ip || turnstile.data.ip !== ip) return result;
    safetyIdentifier = session.data.safetyIdentifier;
    turnstileGuid = turnstile.data.guid;
    const declaredLength = request.headers.get('content-length');
    if (
      declaredLength &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
    )
      return result;
    const input = submissionSchema.safeParse(
      await readBoundedJson(request.body, controller.signal)
    );
    if (!input.success || input.data.safety_identifier !== safetyIdentifier) return result;
    const token = input.data.token.trim();
    status = token ? 'pending' : 'token_missing';
    try {
      if (status === 'pending' && (await rateLimited(turnstileGuid, ip, controller.signal))) {
        status = 'rate_limited';
      }
      const record: WatchwoodTokenRecord = {
        token: status === 'pending' ? token : '',
        ip,
        turnstileGuid,
        receivedAt: Date.now(),
        status,
      };
      await storeToken(safetyIdentifier, record, controller.signal);
    } catch {
      status = 'unavailable';
    }
  } catch {
    if (controller.signal.aborted) status = 'unavailable';
  } finally {
    clearTimeout(timeout);
    console.info('[auth] Watchwood signup token', {
      shadow: true,
      enforced: false,
      status,
      safetyIdentifier,
      latencyMs: Date.now() - startedAt,
    });
  }
  return result;
}
