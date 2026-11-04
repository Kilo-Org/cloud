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
const ASSESSMENT_COOKIE = 'watchwood_signup_assessment';
const MAX_AGE_SECONDS = 60 * 60;
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
const turnstileSchema = z.object({ guid: z.uuid(), watchwoodIp: z.string() });
const assessmentBase = z.object({
  safetyIdentifier: z.uuid().optional(),
  latencyMs: z.number().finite().nonnegative(),
  assessedAt: z.number().int().nonnegative(),
});
const assessmentSchema = z.discriminatedUnion('status', [
  assessmentBase.extend({
    status: z.literal('assessed'),
    riskScore: z.number().finite().min(0).max(1),
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
  }),
]);
const assessmentCookieSchema = z.object({ assessment: assessmentSchema, turnstileGuid: z.uuid() });
const submissionSchema = z.object({
  token: z.string().max(8192).default(''),
  safety_identifier: z.uuid(),
});

export type WatchwoodSignupAssessment = z.infer<typeof assessmentSchema>;

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

function missingAssessment(
  status: 'missing' | 'invalid_context' | 'unavailable'
): WatchwoodSignupAssessment {
  return { status, latencyMs: 0, assessedAt: Date.now() };
}

export async function readWatchwoodSignupAssessment(): Promise<
  WatchwoodSignupAssessment | undefined
> {
  if (!config()) return undefined;
  try {
    const store = await cookies();
    const raw = store.get(ASSESSMENT_COOKIE)?.value;
    const assessment = assessmentCookieSchema.safeParse(verify(raw, ASSESSMENT_COOKIE));
    const session = identitySchema.safeParse(
      verify(store.get(SESSION_COOKIE)?.value, SESSION_COOKIE)
    );
    const turnstile = turnstileSchema.safeParse(verify(store.get('turnstile_jwt')?.value));
    try {
      store.delete(ASSESSMENT_COOKIE);
      store.delete(SESSION_COOKIE);
    } catch {
      // Some authentication callbacks expose read-only cookies.
    }
    if (!raw) return missingAssessment('missing');
    if (
      !assessment.success ||
      !session.success ||
      !turnstile.success ||
      assessment.data.turnstileGuid !== turnstile.data.guid ||
      assessment.data.assessment.safetyIdentifier !== session.data.safetyIdentifier
    ) {
      return missingAssessment('invalid_context');
    }
    return assessment.data.assessment;
  } catch {
    return missingAssessment('unavailable');
  }
}

function safeAssessment(assessment: WatchwoodSignupAssessment) {
  return {
    status: assessment.status,
    safetyIdentifier: assessment.safetyIdentifier,
    latencyMs: assessment.latencyMs,
    assessedAt: assessment.assessedAt,
    ...(assessment.status === 'assessed' ? { riskScore: assessment.riskScore } : {}),
  };
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
  let status: WatchwoodSignupAssessment['status'] = 'invalid_context';
  let riskScore: number | undefined;
  try {
    const session = identitySchema.safeParse(
      verify(request.cookies.get(SESSION_COOKIE)?.value, SESSION_COOKIE)
    );
    const turnstile = turnstileSchema.safeParse(
      verify(request.cookies.get('turnstile_jwt')?.value)
    );
    const ip = getTrustedSignupClientIp(request.headers);
    if (!session.success || !turnstile.success || !ip || turnstile.data.watchwoodIp !== ip)
      return result;
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
    if (!input.data.token.trim()) {
      status = 'token_missing';
      return result;
    }
    status = 'unavailable';
    if (await rateLimited(turnstileGuid, ip, controller.signal)) {
      status = 'rate_limited';
      return result;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      controller.signal.throwIfAborted();
      const upstream = await fetch(CREATE_ACCOUNT_URL, {
        method: 'POST',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${enabled.apiKey}`,
          'Content-Type': 'application/json',
          'X-OpenAI-Watchwood-Token': input.data.token,
          'X-OpenAI-Watchwood-Client-IP': ip,
        },
        body: JSON.stringify({ safety_identifier: safetyIdentifier }),
      });
      if (upstream.status >= 500 && upstream.status <= 599 && attempt === 0) {
        void upstream.body?.cancel().catch(() => undefined);
      } else {
        if (!upstream.ok) {
          void upstream.body?.cancel().catch(() => undefined);
          status = 'upstream_error';
          return result;
        }
        status = 'invalid_response';
        const parsed = z
          .object({ risk_score: z.number().finite().min(0).max(1) })
          .safeParse(await readBoundedJson(upstream.body, controller.signal));
        if (parsed.success) {
          status = 'assessed';
          riskScore = parsed.data.risk_score;
        }
        return result;
      }
    }
  } catch {
    if (controller.signal.aborted) status = 'unavailable';
  } finally {
    clearTimeout(timeout);
    const base = { safetyIdentifier, latencyMs: Date.now() - startedAt, assessedAt: Date.now() };
    const assessment: WatchwoodSignupAssessment =
      status === 'assessed' && riskScore !== undefined
        ? { ...base, status: 'assessed', riskScore }
        : { ...base, status: status === 'assessed' ? 'invalid_response' : status };
    console.info('[auth] Watchwood signup attempt', {
      shadow: true,
      enforced: false,
      ...safeAssessment(assessment),
    });
    if (safetyIdentifier && turnstileGuid) {
      try {
        result.cookies.set(
          ASSESSMENT_COOKIE,
          sign({ assessment, turnstileGuid }, ASSESSMENT_COOKIE),
          cookieOptions()
        );
      } catch {
        // Signing failure must not change authentication behavior.
      }
    }
  }
  return result;
}
