import { createHash, randomUUID } from 'node:crypto';
import { UTS_CLIENT_ASSERTION_TYPE, UTS_ENDPOINTS } from '@kilocode/uts-contracts';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, jwtVerify } from 'jose';

/**
 * A generated `kilo-web` key and an in-process stand-in for the UTS browser-session endpoints of
 * the development issuer, with the contract's form, assertion and answer rules. Synthetic only:
 * every key is generated per test.
 */

export type KiloWebTestKey = { privateJwk: string; publicKey: CryptoKey; kid: string };

export async function generateKiloWebTestKey(): Promise<KiloWebTestKey> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(privateKey);
  if (jwk.x === undefined || jwk.d === undefined) throw new Error('no key material');
  const kid = `kilo-web-${await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x })}`;
  const privateJwk = JSON.stringify({
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid,
    x: jwk.x,
    d: jwk.d,
  });
  return { privateJwk, publicKey, kid };
}

/** How the session signed in at UTS: its methods and, for SSO, the verified WorkOS ids. */
export type FakeSignIn = { amr: string[]; sso_connection?: string; sso_organization?: string };

export type FakeSession = FakeSignIn & {
  session_id: string;
  subject: string;
  auth_time: number;
  issued_at: number;
  idle_expires_at: number;
  expires_at: number;
  ended: boolean;
};

type PendingCode = {
  subject: string;
  redirectUri: string;
  challenge: string;
  sessionId: string;
  signIn: FakeSignIn;
};

export type FakeUtsCall = { path: string; status: number };

export type FakeUts = {
  issuer: string;
  fetch: typeof fetch;
  calls: FakeUtsCall[];
  sessions: Map<string, FakeSession>;
  touches(): number;
  /** What UTS would store after a sign-in: a code for `subject` on `redirectUri`. */
  issueCode(subject: string, redirectUri: string, challenge: string, signIn?: FakeSignIn): string;
  /** The next call to `path` answers this instead. */
  failNext(path: string, status: number, body: unknown, headers?: HeadersInit): void;
  /** Ages every session so its idle clock is due to move. */
  ageIdle(seconds: number): void;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const now = () => Math.floor(Date.now() / 1000);

export function createFakeUts(key: KiloWebTestKey): FakeUts {
  const issuer = UTS_ENDPOINTS.development.issuer;
  const codes = new Map<string, PendingCode>();
  const sessions = new Map<string, FakeSession>();
  const usedJti = new Set<string>();
  const calls: FakeUtsCall[] = [];
  const forced = new Map<string, { status: number; body: unknown; headers?: HeadersInit }>();
  let touches = 0;

  const json = (status: number, body: unknown, headers?: HeadersInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
    });

  /** The contract's client authentication: EdDSA under the key, `aud` the exact URL, `jti` once. */
  async function authenticated(form: URLSearchParams, url: string): Promise<boolean> {
    if (form.get('client_assertion_type') !== UTS_CLIENT_ASSERTION_TYPE) return false;
    try {
      const { payload, protectedHeader } = await jwtVerify(
        form.get('client_assertion') ?? '',
        key.publicKey,
        { issuer: 'kilo-web', subject: 'kilo-web', audience: url, algorithms: ['EdDSA'] }
      );
      if (protectedHeader.kid !== key.kid || typeof payload.jti !== 'string') return false;
      if (usedJti.has(payload.jti)) return false;
      usedJti.add(payload.jti);
      return (payload.exp ?? 0) - (payload.iat ?? 0) <= 300;
    } catch {
      return false;
    }
  }

  function sessionFields(session: FakeSession) {
    const { session_id, subject, auth_time, amr, issued_at, idle_expires_at, expires_at } = session;
    const { sso_connection, sso_organization } = session;
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

  async function handle(url: string, form: URLSearchParams): Promise<Response> {
    const path = url.slice(issuer.length);
    const override = forced.get(path);
    if (override !== undefined) {
      forced.delete(path);
      return json(override.status, override.body, override.headers);
    }
    if (!(await authenticated(form, url))) return json(401, { error: 'invalid_client' });
    if (path === '/token') {
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      const verifier = form.get('code_verifier') ?? '';
      if (
        form.get('grant_type') !== 'authorization_code' ||
        pending === undefined ||
        pending.redirectUri !== form.get('redirect_uri') ||
        pending.challenge !== sha256(verifier)
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const handleValue = sha256(`${code}.${verifier}`);
      const issued = now();
      const session: FakeSession = sessions.get(handleValue) ?? {
        session_id: pending.sessionId,
        subject: pending.subject,
        auth_time: issued,
        ...pending.signIn,
        issued_at: issued,
        idle_expires_at: issued + 14 * 24 * 3600,
        expires_at: issued + 30 * 24 * 3600,
        ended: false,
      };
      sessions.set(handleValue, session);
      const token = { access_token: `at-${randomUUID()}`, token_type: 'Bearer', expires_in: 600 };
      return json(200, {
        ...token,
        scope: 'uts:browser-session.read',
        issued_tokens: [{ ...token, audience: 'uts', scope: 'uts:browser-session.read' }],
        session_handle: handleValue,
        ...sessionFields(session),
      });
    }
    const session = sessions.get(form.get('session_handle') ?? '');
    const live = session !== undefined && !session.ended && session.idle_expires_at > now();
    if (path === '/account/browser-sessions/read') {
      return live
        ? json(200, { status: 'active', ...sessionFields(session) })
        : json(401, { error: 'invalid_session' });
    }
    if (path === '/account/browser-sessions/token') {
      if (!live) return json(401, { error: 'invalid_session' });
      if (form.get('scope') !== 'uts:browser-session.read' || form.get('resource') !== issuer) {
        return json(400, { error: 'invalid_scope' });
      }
      touches += 1;
      session.idle_expires_at = Math.min(session.expires_at, now() + 14 * 24 * 3600);
      return json(200, {
        access_token: `at-${randomUUID()}`,
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'uts:browser-session.read',
      });
    }
    if (path === '/account/browser-sessions/end') {
      if (session === undefined) return json(401, { error: 'invalid_session' });
      const first = !session.ended;
      session.ended = true;
      return json(
        200,
        first ? { status: 'ended', session_id: session.session_id } : { status: 'ended' }
      );
    }
    return json(404, { error: 'not_found' });
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(`${issuer}/`)) throw new Error(`unexpected request to ${url}`);
    if (init?.redirect !== 'manual') throw new Error('redirects must not be followed');
    const body = init.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    const response = await handle(url, body);
    calls.push({ path: url.slice(issuer.length), status: response.status });
    return response;
  };

  return {
    issuer,
    fetch: fetchImpl,
    calls,
    sessions,
    touches: () => touches,
    issueCode(subject, redirectUri, challenge, signIn = { amr: ['email'] }) {
      const code = randomUUID();
      codes.set(code, { subject, redirectUri, challenge, sessionId: randomUUID(), signIn });
      return code;
    },
    failNext(path: string, status: number, body: unknown, headers?: HeadersInit): void {
      forced.set(path, { status, body, headers });
    },
    ageIdle(seconds: number): void {
      for (const session of sessions.values()) session.idle_expires_at -= seconds;
    },
  };
}
