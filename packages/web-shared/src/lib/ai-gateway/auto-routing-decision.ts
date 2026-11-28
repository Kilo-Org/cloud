import {
  AutoRoutingDecisionResponseSchema,
  CustomRouterErrorResponseSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  type AutoRoutingDecision,
  type AutoRoutingDecisionResponse,
  type AutoRouter,
  type CustomRouterErrorCode,
  type CustomRouterErrorResponse,
  type CustomRouterDefinition,
  type CustomRouterReference,
  normalizeClassifierInput,
} from '@kilocode/auto-routing-contracts';
import type { ClassifierApiKind, MirrorPayload } from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL } from '@kilocode/web-shared/lib/config.server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { parseInternalServiceUrl } from '@kilocode/web-shared/lib/internal-service-url';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { autoRoutingCredential } from './auto-routing-sender';

export const EFFICIENT_DECISION_TIMEOUT_MS = 5_000;

export type EfficientDecisionParams = {
  router?: AutoRouter;
  customRouter?: CustomRouterReference;
  /**
   * The pool definition the gateway already read for its own deny policy. Only the private
   * authenticated custom-router path sets it, so the worker decides against the same pins the
   * gateway enforces instead of its own cached or replicated copy.
   */
  customRouterDefinition?: CustomRouterDefinition;
  /**
   * Alias id -> the concrete target that same primary snapshot stored, so the worker ranks the
   * model that would actually run. Only the private authenticated custom-router path sets it.
   */
  customRouterAliasTargets?: ReadonlyMap<string, string>;
  apiKind: ClassifierApiKind;
  body: unknown;
  requestedModel: string;
  providerHints: MirrorPayload['input']['providerHints'];
  bodyBytes: number;
  userId: string;
  organizationId: string | null;
  sessionId: string | null;
  machineId: string | null;
  clientRequestId: string | null;
  mode: string | null;
  userAgent: string | null;
  deniedModelIds?: ReadonlyArray<string>;
};

type FetchEfficientDecisionOptions = {
  workerUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  onError?: (message: string, data: { error: string }) => void;
};

// The outbound decide body: MirrorPayload plus the pool definition only the trusted custom-router
// caller supplies. The worker validates the envelope it receives.
type DecidePayload = MirrorPayload & { customRouterDefinition?: CustomRouterDefinition };

function buildDecidePayload(params: EfficientDecisionParams): DecidePayload | null {
  const normalizedInput = normalizeClassifierInput(params.apiKind, params.body, {
    requestedModel: params.requestedModel,
    providerHints: params.providerHints,
  });
  if (!normalizedInput) return null;

  // Compute capability-aware routing hints from the original body (the
  // caller mutates it after this thunk runs, so the full body is only
  // available here). Omit each field when it carries no information, and
  // omit `constraints` entirely when both would be absent, so today's
  // payload shape is preserved byte-for-byte for text-only, sub-token
  // requests.
  const requiredInputModalities = detectRequiredInputModalities(params.body);
  const promptTokensEstimate = estimateRoutingTokens(params.body);
  const constraints: MirrorPayload['constraints'] =
    requiredInputModalities.length > 0 || promptTokensEstimate > 0
      ? {
          ...(requiredInputModalities.length > 0 ? { requiredInputModalities } : {}),
          ...(promptTokensEstimate > 0 ? { promptTokensEstimate } : {}),
        }
      : undefined;

  return {
    input: normalizedInput,
    ...(params.router ? { router: params.router } : {}),
    ...(params.customRouter ? { customRouter: params.customRouter } : {}),
    ...(params.customRouter && params.customRouterDefinition
      ? { customRouterDefinition: params.customRouterDefinition }
      : {}),
    ...(params.customRouter && params.customRouterAliasTargets?.size
      ? { customRouterAliasTargets: Object.fromEntries(params.customRouterAliasTargets) }
      : {}),
    ...(params.deniedModelIds?.length
      ? { routingPolicy: { deniedModelIds: [...params.deniedModelIds] } }
      : {}),
    ...(constraints ? { constraints } : {}),
    userId: params.userId,
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    machineId: params.machineId,
    clientRequestId: params.clientRequestId,
    mode: params.mode,
    userAgent: params.userAgent,
    bodyBytes: params.bodyBytes,
  };
}

/**
 * The legacy bearer: the caller's token, else the internal API secret. A secret that cannot be
 * read is reported through `onError` and leaves the worker uncalled, like an unset one.
 */
async function workerAuthToken(options: FetchEfficientDecisionOptions): Promise<string> {
  if (options.authToken !== undefined) return options.authToken;
  try {
    return await readInternalApiSecret();
  } catch (error) {
    (options.onError ?? warnExceptInTest)('Efficient auto decision secret unavailable', {
      error: error instanceof Error ? error.name : String(error),
    });
    return '';
  }
}

type DecideCredential = {
  authorization: string;
  /** An STS token is for the Worker's origin only: a redirect fails rather than carry it on. */
  redirect?: 'error';
};

/** Credential failure reasons already reported: decide runs on every auto-routed LLM request. */
const reportedCredentialFailures = new Set<string>();

/**
 * The decide call's credential (`auto-routing-sender.ts`): the legacy bearer while the gateway's
 * `AUTO_ROUTING_DECIDE_SENDER_AUTH` is `legacy`, or an `auto-routing:decide` STS token under `sts`.
 * A held token is a memory read; a cold instance waits for one mint within the decide deadline
 * (`signal`). Without a credential the worker is left uncalled, and `sts` never falls back to the
 * secret.
 */
async function decideCredential(
  workerUrl: URL,
  options: FetchEfficientDecisionOptions,
  signal: AbortSignal
): Promise<DecideCredential | null> {
  const sender = await autoRoutingCredential('decide', { url: workerUrl, signal });
  switch (sender.kind) {
    case 'legacy': {
      const authToken = await workerAuthToken(options);
      return authToken ? { authorization: `Bearer ${authToken}` } : null;
    }
    case 'sts':
      return { authorization: sender.authorization, redirect: 'error' };
    case 'unavailable':
      // Once per reason and process: a misconfigured switch would otherwise warn on every request.
      if (!reportedCredentialFailures.has(sender.reason)) {
        reportedCredentialFailures.add(sender.reason);
        (options.onError ?? warnExceptInTest)('Efficient auto decision credential unavailable', {
          error: sender.reason,
        });
      }
      return null;
  }
}

type DecideOutcome =
  | { kind: 'ok'; response: AutoRoutingDecisionResponse }
  | { kind: 'rejected'; error: CustomRouterErrorResponse['error'] }
  | { kind: 'failed' };

async function postDecision(
  payload: DecidePayload,
  workerUrl: URL,
  credential: DecideCredential,
  signal: AbortSignal,
  options: FetchEfficientDecisionOptions
): Promise<DecideOutcome> {
  const onError = options.onError ?? warnExceptInTest;
  const startedAt = performance.now();
  let status: number | null = null;
  let outcome: 'ok' | 'timeout' | 'error' | 'http_error' | 'invalid_response' = 'error';
  try {
    const response = await fetch(new URL('/decide', workerUrl).toString(), {
      method: 'POST',
      headers: new Headers({
        authorization: credential.authorization,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(payload),
      signal,
      ...(credential.redirect ? { redirect: credential.redirect } : {}),
    });
    status = response.status;
    if (!response.ok) {
      outcome = 'http_error';
      const rejection = CustomRouterErrorResponseSchema.safeParse(
        await response.json().catch(() => null)
      );
      if (!rejection.success || !isCallerRejection(rejection.data.error.code)) {
        onError('Efficient auto decision request failed', { error: `status ${response.status}` });
      }
      return rejection.success
        ? { kind: 'rejected', error: rejection.data.error }
        : { kind: 'failed' };
    }
    const parsed = AutoRoutingDecisionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      outcome = 'invalid_response';
      onError('Efficient auto decision response invalid', { error: 'invalid_response' });
      return { kind: 'failed' };
    }
    outcome = 'ok';
    return { kind: 'ok', response: parsed.data };
  } catch (error) {
    outcome = signal.aborted ? 'timeout' : 'error';
    onError('Efficient auto decision request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed' };
  } finally {
    const durationMs = performance.now() - startedAt;
    const sampled = outcome === 'ok';
    if (!sampled || Math.random() < 0.01) {
      console.log(
        JSON.stringify({
          event: 'auto_routing_decide_client',
          durationMs,
          outcome,
          status,
          sampled,
          customRouter: payload.customRouter !== undefined,
        })
      );
    }
  }
}

// Worker-owned usage survives a lost response. Positive response costs belong
// to legacy workers and must still be billed by the gateway during rollout.
export async function fetchEfficientAutoDecision(
  params: EfficientDecisionParams,
  options: FetchEfficientDecisionOptions = {}
): Promise<{ decision: AutoRoutingDecision | null; costUsd: number } | null> {
  const workerUrl = parseInternalServiceUrl(options.workerUrl ?? AUTO_ROUTING_WORKER_URL);
  if (!workerUrl) return null;
  // One deadline, started before the credential read so a cold mint counts inside it.
  const signal = AbortSignal.timeout(options.timeoutMs ?? EFFICIENT_DECISION_TIMEOUT_MS);
  const credential = await decideCredential(workerUrl, options, signal);
  if (!credential) return null;

  const payload = buildDecidePayload(params);
  if (!payload) return null;

  const outcome = await postDecision(payload, workerUrl, credential, signal, options);
  return outcome.kind === 'ok'
    ? { decision: outcome.response.decision, costUsd: outcome.response.cost }
    : null;
}

export type CustomRouterDecisionOutcome =
  | { kind: 'ok'; decision: AutoRoutingDecision | null; costUsd: number }
  | { kind: 'rejected'; code: CustomRouterErrorCode; message: string }
  | { kind: 'unavailable' };

// Only rejections about the caller's router reach the client. Any other worker error (an internal
// secret mismatch, a quota, an internal fault) is the gateway's problem, not the caller's.
const CALLER_REJECTIONS = ['router_not_found', 'custom_router_unavailable'] as const;

function isCallerRejection(code: CustomRouterErrorCode): boolean {
  return (CALLER_REJECTIONS as readonly CustomRouterErrorCode[]).includes(code);
}

// A custom router never falls back outside its pool (ADR 0005 invariant 2), so a worker that
// cannot answer is reported as such instead of turning into a static fallback model.
export async function fetchCustomRouterDecision(
  params: EfficientDecisionParams & { customRouter: CustomRouterReference },
  options: FetchEfficientDecisionOptions = {}
): Promise<CustomRouterDecisionOutcome> {
  const workerUrl = parseInternalServiceUrl(options.workerUrl ?? AUTO_ROUTING_WORKER_URL);
  // One deadline, started before the credential read so a cold mint counts inside it.
  const signal = AbortSignal.timeout(options.timeoutMs ?? EFFICIENT_DECISION_TIMEOUT_MS);
  const credential = workerUrl ? await decideCredential(workerUrl, options, signal) : null;
  if (!workerUrl || !credential) {
    return { kind: 'unavailable' };
  }

  const payload = buildDecidePayload(params);
  if (!payload) {
    return { kind: 'rejected', code: 'invalid_request', message: 'Messages cannot be classified' };
  }

  const outcome = await postDecision(payload, workerUrl, credential, signal, options);
  if (outcome.kind === 'ok') {
    return { kind: 'ok', decision: outcome.response.decision, costUsd: outcome.response.cost };
  }
  if (outcome.kind === 'rejected' && isCallerRejection(outcome.error.code)) {
    return { kind: 'rejected', code: outcome.error.code, message: outcome.error.message };
  }
  return { kind: 'unavailable' };
}
