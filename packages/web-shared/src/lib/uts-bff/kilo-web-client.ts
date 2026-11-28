import 'server-only';
import {
  BrowserSessionEndSchema,
  BrowserSessionGrantSchema,
  BrowserSessionReadSchema,
  BrowserSessionTokenSchema,
  SessionHandleSchema,
  UTS_BROWSER_SESSION_END_PATH,
  UTS_BROWSER_SESSION_READ_PATH,
  UTS_BROWSER_SESSION_READ_SCOPE,
  UTS_BROWSER_SESSION_TOKEN_PATH,
  UTS_CLIENT_ASSERTION_TYPE,
  UTS_TOKEN_PATH,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import {
  signClientAssertion,
  type KiloWebSigningKeyAnswer,
  type KiloWebSigningKeyProvider,
} from '@kilocode/web-shared/lib/uts-bff/kilo-web-key';

/**
 * The server-side `kilo-web` client of UTS (design 5.1, 5.5; `@kilocode/uts-contracts`
 * `browser-sessions.ts`): the code exchange that starts a browser session, `read`, the bootstrap
 * `token` that keeps the session's idle clock moving, and `end`. Every call is a form POST with
 * its own client assertion for the exact URL called, and never follows a redirect, so a handle or
 * an assertion reaches only the environment's issuer. The BFF holds no refresh token: the opaque
 * session handle plus this client's key is the only way to use a session.
 */

/** A UTS answer is a few short members around at most 8 access tokens of about 1 KB. */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** One call: the key read, signing, the request and the body. */
const CALL_BUDGET_MS = 8_000;
/** How far this server's clock may disagree with UTS's. */
const CLOCK_SKEW_SECONDS = 60;
/** An RFC 6749 error body: only its stable code is kept, never its description. */
const OAuthErrorBodySchema = z.object({ error: z.string().regex(/^[a-z_]{1,64}$/) });
const SECONDS_PATTERN = /^\d{1,7}$/;

/** The session fields every exchange and read answer carries. */
export type BrowserSession = {
  session_id: string;
  subject: string;
  auth_time: number;
  amr: string[];
  sso_connection?: string;
  sso_organization?: string;
  issued_at: number;
  idle_expires_at: number;
  expires_at: number;
};

/**
 * Every answer of a call. Only `ok` holds a handle or a session; every other outcome carries codes,
 * statuses and seconds only, so a caller may log it whole. `invalid_session`: UTS says the handle
 * names no live session (or the handle is malformed), the one outcome that ends the browser's
 * session. `retryable`: UTS asked for a retry (429, 503) or did not answer, or the key cannot be
 * read now. `failed`: anything else; it says nothing about the session.
 */
export type KiloWebOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'invalid_session' }
  | {
      kind: 'retryable';
      reason: 'unavailable' | 'rate_limited' | 'timeout' | 'network' | 'client_key_unavailable';
      retryAfterSeconds: number | null;
    }
  | {
      kind: 'failed';
      reason:
        | 'refused'
        | 'redirect'
        | 'upstream_error'
        | 'malformed_response'
        | 'client_key_invalid';
      error: string | null;
      httpStatus: number | null;
    };

export type KiloWebClient = {
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<KiloWebOutcome<{ handle: string; session: BrowserSession }>>;
  /** The live session a handle names. It moves no clock. */
  readSession(handle: string): Promise<KiloWebOutcome<BrowserSession>>;
  /** Mints the bootstrap scope and drops the token; UTS moves the idle clock at most every 5 min. */
  touchSession(handle: string): Promise<KiloWebOutcome<null>>;
  /** Ends only this session (its `sid` goes to the revocation feed). Safe to repeat. */
  endSession(handle: string): Promise<KiloWebOutcome<null>>;
};

/** The clock-free order of a session's times, and its liveness by this server's clock. */
function isUsableSession(session: BrowserSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  return (
    session.auth_time <= session.issued_at &&
    session.issued_at <= session.idle_expires_at &&
    session.idle_expires_at <= session.expires_at &&
    session.issued_at <= now + CLOCK_SKEW_SECONDS &&
    session.idle_expires_at > now - CLOCK_SKEW_SECONDS
  );
}

function sessionOf(answer: BrowserSession): BrowserSession {
  const { session_id, subject, auth_time, amr, sso_connection, sso_organization } = answer;
  const { issued_at, idle_expires_at, expires_at } = answer;
  return {
    session_id,
    subject,
    auth_time,
    amr,
    ...(sso_connection === undefined ? {} : { sso_connection }),
    ...(sso_organization === undefined ? {} : { sso_organization }),
    issued_at,
    idle_expires_at,
    expires_at,
  };
}

/** The body as UTF-8 text, or null past `limit` bytes; the rest is never read. */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createKiloWebClient(config: {
  issuer: string;
  signingKey: KiloWebSigningKeyProvider;
  fetch?: typeof fetch;
}): KiloWebClient {
  const fetchImpl = config.fetch ?? fetch;

  async function call<T>(
    path: string,
    fields: Record<string, string>,
    schema: z.ZodType<T>
  ): Promise<KiloWebOutcome<T>> {
    // One budget covers the key read, signing, the request and the body.
    const signal = AbortSignal.timeout(CALL_BUDGET_MS);
    const expired = Promise.withResolvers<'timeout'>();
    signal.addEventListener('abort', () => expired.resolve('timeout'), { once: true });
    let key: KiloWebSigningKeyAnswer | 'timeout';
    try {
      key = await Promise.race([config.signingKey(), expired.promise]);
    } catch {
      key = { status: 'unavailable' };
    }
    if (key === 'timeout') {
      return { kind: 'retryable', reason: 'timeout', retryAfterSeconds: null };
    }
    if (key.status === 'unavailable') {
      return { kind: 'retryable', reason: 'client_key_unavailable', retryAfterSeconds: null };
    }
    if (key.status === 'invalid') {
      return { kind: 'failed', reason: 'client_key_invalid', error: null, httpStatus: null };
    }
    const url = `${config.issuer}${path}`;
    let assertion: string;
    try {
      assertion = await signClientAssertion(key.key, url);
    } catch {
      return { kind: 'failed', reason: 'client_key_invalid', error: null, httpStatus: null };
    }

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          ...fields,
          client_assertion_type: UTS_CLIENT_ASSERTION_TYPE,
          client_assertion: assertion,
        }),
        redirect: 'manual',
        cache: 'no-store',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        return { kind: 'failed', reason: 'redirect', error: null, httpStatus: response.status };
      }
      if (response.status === 429 || response.status === 503) {
        void response.body?.cancel().catch(() => undefined);
        const retryAfter = response.headers.get('Retry-After')?.trim() ?? '';
        return {
          kind: 'retryable',
          reason: response.status === 429 ? 'rate_limited' : 'unavailable',
          retryAfterSeconds: SECONDS_PATTERN.test(retryAfter) ? Number(retryAfter) : null,
        };
      }
      if (response.status >= 500) {
        void response.body?.cancel().catch(() => undefined);
        return {
          kind: 'failed',
          reason: 'upstream_error',
          error: null,
          httpStatus: response.status,
        };
      }
      const body = await readBounded(response, MAX_RESPONSE_BYTES);
      if (body === null) {
        return {
          kind: 'failed',
          reason: 'malformed_response',
          error: null,
          httpStatus: response.status,
        };
      }
      text = body;
    } catch (error) {
      return {
        kind: 'retryable',
        reason:
          error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network',
        retryAfterSeconds: null,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0].trim();
    if (response.status !== 200) {
      const error = OAuthErrorBodySchema.safeParse(json).data?.error ?? null;
      if (error === 'invalid_session') return { kind: 'invalid_session' };
      return { kind: 'failed', reason: 'refused', error, httpStatus: response.status };
    }
    // RFC 6749 section 5.1 and the contract: every answer is JSON and `no-store`.
    const noStore = (response.headers.get('Cache-Control') ?? '')
      .toLowerCase()
      .split(',')
      .some(directive => directive.trim() === 'no-store');
    const parsed = schema.safeParse(json);
    if (contentType.toLowerCase() !== 'application/json' || !noStore || !parsed.success) {
      return { kind: 'failed', reason: 'malformed_response', error: null, httpStatus: 200 };
    }
    return { kind: 'ok', value: parsed.data };
  }

  const malformed = <T>(): KiloWebOutcome<T> => ({
    kind: 'failed',
    reason: 'malformed_response',
    error: null,
    httpStatus: 200,
  });

  async function onHandle<T>(
    handle: string,
    run: () => Promise<KiloWebOutcome<T>>
  ): Promise<KiloWebOutcome<T>> {
    // A malformed handle names no session; it is never sent.
    return SessionHandleSchema.safeParse(handle).success ? run() : { kind: 'invalid_session' };
  }

  return {
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const answer = await call(
        UTS_TOKEN_PATH,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
        BrowserSessionGrantSchema
      );
      if (answer.kind !== 'ok') return answer;
      if (!isUsableSession(answer.value)) return malformed();
      return {
        kind: 'ok',
        value: { handle: answer.value.session_handle, session: sessionOf(answer.value) },
      };
    },

    readSession: handle =>
      onHandle(handle, async () => {
        const answer = await call(
          UTS_BROWSER_SESSION_READ_PATH,
          { session_handle: handle },
          BrowserSessionReadSchema
        );
        if (answer.kind !== 'ok') return answer;
        return isUsableSession(answer.value)
          ? { kind: 'ok', value: sessionOf(answer.value) }
          : malformed();
      }),

    touchSession: handle =>
      onHandle(handle, async () => {
        const answer = await call(
          UTS_BROWSER_SESSION_TOKEN_PATH,
          {
            session_handle: handle,
            scope: UTS_BROWSER_SESSION_READ_SCOPE,
            resource: config.issuer,
          },
          BrowserSessionTokenSchema
        );
        if (answer.kind !== 'ok') return answer;
        return answer.value.scope === UTS_BROWSER_SESSION_READ_SCOPE
          ? { kind: 'ok', value: null }
          : malformed();
      }),

    endSession: handle =>
      onHandle(handle, async () => {
        const answer = await call(
          UTS_BROWSER_SESSION_END_PATH,
          { session_handle: handle },
          BrowserSessionEndSchema
        );
        return answer.kind === 'ok' ? { kind: 'ok', value: null } : answer;
      }),
  };
}
