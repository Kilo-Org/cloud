import type {
  MintBinding,
  ServiceTokenError,
  ServiceTokensExecutionContext,
} from '@kilocode/service-token-client';
import { readStsToken, senderAuth, type StsTokenUnavailableReason } from '../sts-service-tokens.js';
import type { CallbackTarget } from './types.js';

/**
 * The switch of each callback receiver (`sts-service-tokens.ts`), so each receiver moves to STS on
 * its own (decision D59). Each is one Worker var.
 */
export type CallbackSenderAuthEnv = {
  STS?: MintBinding;
  CALLBACK_SENDER_AUTH_WEB?: string;
  CALLBACK_SENDER_AUTH_WEBHOOK_AGENT_INGEST?: string;
  CALLBACK_SENDER_AUTH_SECURITY_AUTO_ANALYSIS?: string;
};

type CallbackSwitch = Exclude<keyof CallbackSenderAuthEnv, 'STS'>;

/**
 * A Kilo service route that receives this Worker's execution callbacks. `legacyHeaders` name the
 * receiver-issued callback token the target carries: the receiver derives it from
 * `CALLBACK_TOKEN_SECRET` and this Worker passes it through unread. Under `sts` the request
 * carries only the STS token, so those headers are left out (a receiver refuses a request that
 * names two credential families).
 */
type CallbackRoute = {
  audience: string;
  scope: string;
  origin: string;
  path: RegExp;
  legacyHeaders: readonly string[];
  switch: CallbackSwitch;
};

/**
 * The production callback routes. STS grants each scope only to the `cloud-agent-next` workload;
 * until a scope is in `STS_SCOPE_REGISTRY` and the grant is in
 * `services/sts/policy/cloud-agent-next.yaml`, STS refuses it and nothing is sent under `sts`.
 * Origins are the production targets the callers build: the web app's `APP_URL` (bot, Security
 * Agent and code review callbacks), Webhook Agent Ingest's `WEBHOOK_AGENT_URL` and Security Auto
 * Analysis's `SECURITY_ANALYSIS_CALLBACK_WORKER_BASE_URL`.
 */
export const CALLBACK_ROUTES: readonly CallbackRoute[] = [
  {
    audience: 'web',
    scope: 'web:bot-session.callback',
    origin: 'https://app.kilo.ai',
    path: /^\/api\/internal\/bot-session-callback\/[^/]+$/,
    legacyHeaders: ['x-bot-callback-token'],
    switch: 'CALLBACK_SENDER_AUTH_WEB',
  },
  {
    audience: 'web',
    scope: 'web:security-analysis.callback',
    origin: 'https://app.kilo.ai',
    path: /^\/api\/internal\/security-analysis-callback\/[^/]+$/,
    legacyHeaders: ['x-callback-token'],
    switch: 'CALLBACK_SENDER_AUTH_WEB',
  },
  {
    audience: 'web',
    scope: 'web:code-review.agent-callback',
    origin: 'https://app.kilo.ai',
    path: /^\/api\/internal\/code-review-status\/[A-Za-z0-9_-]{1,128}$/,
    legacyHeaders: ['x-callback-token'],
    switch: 'CALLBACK_SENDER_AUTH_WEB',
  },
  {
    audience: 'webhook-agent-ingest',
    scope: 'webhook-agent-ingest:execution.callback',
    origin: 'https://hooks.kilosessions.ai',
    path: /^\/api\/callbacks\/execution$/,
    legacyHeaders: ['x-callback-token'],
    switch: 'CALLBACK_SENDER_AUTH_WEBHOOK_AGENT_INGEST',
  },
  {
    audience: 'security-auto-analysis',
    scope: 'security-auto-analysis:analysis.callback',
    origin: 'https://security-auto-analysis.kilosessions.ai',
    path: /^\/internal\/security-analysis-callback\/[^/]+$/,
    legacyHeaders: ['x-callback-token'],
    switch: 'CALLBACK_SENDER_AUTH_SECURITY_AUTO_ANALYSIS',
  },
];

/** The route `url` names exactly: https, no userinfo, a listed origin and path. */
export function callbackRouteOf(url: string): CallbackRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;
  return (
    CALLBACK_ROUTES.find(
      route => route.origin === parsed.origin && route.path.test(parsed.pathname)
    ) ?? null
  );
}

export type CallbackAuthUnavailableReason = 'invalid_auth' | StsTokenUnavailableReason;

/** The headers of one callback request, or why it is not sent. */
export type CallbackAuth =
  | { kind: 'headers'; headers: Record<string, string> }
  | {
      kind: 'unavailable';
      reason: CallbackAuthUnavailableReason;
      deniedReason?: ServiceTokenError['deniedReason'];
    };

/**
 * The headers of one delivery to `target`. A target that is no listed route, or whose receiver's
 * switch is unset or `legacy`, keeps exactly the headers it was registered with. A listed route
 * under `sts` gets its STS token in `Authorization`, without the receiver-issued token or any
 * stored `Authorization`.
 */
export async function callbackAuth(
  env: CallbackSenderAuthEnv,
  target: CallbackTarget,
  ctx?: ServiceTokensExecutionContext
): Promise<CallbackAuth> {
  const stored = { 'Content-Type': 'application/json', ...target.headers };
  const route = callbackRouteOf(target.url);
  if (route === null) return { kind: 'headers', headers: stored };
  const mode = senderAuth(env[route.switch]);
  if (mode === null) return { kind: 'unavailable', reason: 'invalid_auth' };
  if (mode === 'legacy') return { kind: 'headers', headers: stored };

  const read = await readStsToken(env.STS, { audience: route.audience, scope: route.scope }, ctx);
  if (read.kind === 'unavailable') return read;
  const dropped = new Set([...route.legacyHeaders, 'authorization']);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored)) {
    if (!dropped.has(name.toLowerCase())) headers[name] = value;
  }
  headers.Authorization = `Bearer ${read.token}`;
  return { kind: 'headers', headers };
}
