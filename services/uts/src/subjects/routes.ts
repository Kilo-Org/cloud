import {
  AppEventsAckRequestSchema,
  AppEventsReadRequestSchema,
  type AuthorityKind,
  AuthorityKindSchema,
  type SubjectOperation,
  type SubjectOperationAnswer,
  type SubjectOperationResult,
  SubjectOperationSchema,
  UTS_ACCOUNT_IMPORT_PATH,
  UTS_ACCOUNT_IMPORT_SCOPE,
  UTS_APP_EVENTS_ACK_PATH,
  UTS_APP_EVENTS_READ_PATH,
  UTS_APP_EVENTS_SCOPE,
  UTS_AUTHORITY_PATH_PREFIX,
  UTS_AUTHORITY_SCOPE,
  UTS_INTERNAL_WORKLOADS,
  UTS_SSO_CONFLICT_RETRY_SECONDS,
  UTS_SUBJECT_OPERATIONS,
  UTS_SUBJECT_OPERATIONS_PATH_PREFIX,
} from '@kilocode/uts-contracts';
import { jsonResponse } from '../responses';
import {
  type AppEventsResult,
  type AuthorityResult,
  type ImportResult,
  SSO_SYNC_RETRY_SECONDS,
  type SubjectDeps,
  ackAppEvents,
  readAppEvents,
  runAccountImport,
  runAuthoritySync,
  runSubjectOperation,
} from './operations';
import { NO_VERIFIER_RETRY_SECONDS, type ServiceTokenVerifier } from './service-tokens';

/**
 * The `/internal/` routes of the mint Worker, for the web app's outbox (README, "Subject
 * operations and identity import"). Every route takes `POST` with a JSON body and an STS token
 * for audience `uts` with the route's scope from a listed workload. While no verifier is deployed
 * (`noServiceTokenVerifier`), or the identity store is not bound, every route answers
 * `503 temporarily_unavailable` with `Retry-After`, never 500 and never a write.
 */
export type InternalDeps = {
  serviceTokens: ServiceTokenVerifier;
  /** Null until the environment binds its identity store. */
  subjects: SubjectDeps | null;
};

type Route =
  | { kind: 'operation'; operation: SubjectOperation }
  | { kind: 'import' }
  | { kind: 'authority'; authority: AuthorityKind }
  | { kind: 'events_read' }
  | { kind: 'events_ack' };

function routeOf(pathname: string): Route | null {
  if (pathname.startsWith(UTS_SUBJECT_OPERATIONS_PATH_PREFIX)) {
    const name = pathname.slice(UTS_SUBJECT_OPERATIONS_PATH_PREFIX.length);
    const operation = SubjectOperationSchema.safeParse(name);
    return operation.success ? { kind: 'operation', operation: operation.data } : null;
  }
  if (pathname.startsWith(UTS_AUTHORITY_PATH_PREFIX)) {
    const name = pathname.slice(UTS_AUTHORITY_PATH_PREFIX.length);
    const authority = AuthorityKindSchema.safeParse(name);
    return authority.success ? { kind: 'authority', authority: authority.data } : null;
  }
  if (pathname === UTS_ACCOUNT_IMPORT_PATH) return { kind: 'import' };
  if (pathname === UTS_APP_EVENTS_READ_PATH) return { kind: 'events_read' };
  if (pathname === UTS_APP_EVENTS_ACK_PATH) return { kind: 'events_ack' };
  return null;
}

function scopeOf(route: Route): string {
  switch (route.kind) {
    case 'operation':
      return UTS_SUBJECT_OPERATIONS[route.operation].scope;
    case 'import':
      return UTS_ACCOUNT_IMPORT_SCOPE;
    case 'authority':
      return UTS_AUTHORITY_SCOPE;
    case 'events_read':
    case 'events_ack':
      return UTS_APP_EVENTS_SCOPE;
  }
}

function unavailable(retryAfterSeconds: number): Response {
  return jsonResponse({ error: 'temporarily_unavailable' }, 503, {
    'Retry-After': String(retryAfterSeconds),
  });
}

const invalidRequest = () => jsonResponse({ error: 'invalid_request' }, 400);

function operationResponse(result: SubjectOperationResult): Response {
  switch (result.outcome) {
    case 'applied':
    case 'already_applied':
    case 'no_subject': {
      const body: SubjectOperationAnswer = {
        outcome: result.outcome,
        operation_id: result.operationId,
      };
      return jsonResponse(body, 200);
    }
    case 'retry_later': {
      const body: SubjectOperationAnswer = {
        outcome: 'retry_later',
        error: result.error,
        operation_id: result.operationId,
      };
      return jsonResponse(body, 409, { 'Retry-After': String(result.retryAfterSeconds) });
    }
    case 'refused': {
      const body: SubjectOperationAnswer = { outcome: 'refused', error: result.error };
      return jsonResponse(body, 409);
    }
    case 'invalid_request':
      return invalidRequest();
    case 'unavailable':
      return unavailable(result.retryAfterSeconds);
  }
}

function importResponse(result: ImportResult): Response {
  switch (result.outcome) {
    case 'imported':
    case 'already_imported':
      return jsonResponse(result, 200);
    case 'retry_later':
      return jsonResponse(result, 409, { 'Retry-After': String(SSO_SYNC_RETRY_SECONDS) });
    case 'refused':
      return jsonResponse(result, 409);
    case 'invalid_request':
      return invalidRequest();
    case 'unavailable':
      return unavailable(result.retryAfterSeconds);
  }
}

function authorityResponse(result: AuthorityResult): Response {
  switch (result.outcome) {
    case 'applied':
    case 'already_applied':
    case 'no_subject':
      return jsonResponse(result, 200);
    case 'retry_later':
      return jsonResponse(result, 409, {
        'Retry-After': String(UTS_SSO_CONFLICT_RETRY_SECONDS),
      });
    case 'refused':
      return jsonResponse(result, 409);
    case 'invalid_request':
      return invalidRequest();
    case 'unavailable':
      return unavailable(result.retryAfterSeconds);
  }
}

function eventsResponse(result: AppEventsResult): Response {
  switch (result.outcome) {
    case 'read':
      return jsonResponse({ events: result.events }, 200);
    case 'acknowledged':
      return jsonResponse({ acknowledged: result.acknowledged }, 200);
    case 'unavailable':
      return unavailable(result.retryAfterSeconds);
  }
}

async function routeResponse(
  route: Route,
  body: unknown,
  deps: SubjectDeps,
  workload: string
): Promise<Response> {
  switch (route.kind) {
    case 'operation':
      return operationResponse(await runSubjectOperation(deps, route.operation, body, workload));
    case 'import':
      return importResponse(await runAccountImport(deps, body, workload));
    case 'authority':
      return authorityResponse(await runAuthoritySync(deps, route.authority, body, workload));
    case 'events_read': {
      const parsed = AppEventsReadRequestSchema.safeParse(body);
      if (!parsed.success) return invalidRequest();
      return eventsResponse(await readAppEvents(deps, parsed.data.limit));
    }
    case 'events_ack': {
      const parsed = AppEventsAckRequestSchema.safeParse(body);
      if (!parsed.success) return invalidRequest();
      return eventsResponse(await ackAppEvents(deps, parsed.data.event_ids));
    }
  }
}

/** Answers an `/internal/` route, or null for any other path. */
export async function handleInternalRequest(
  request: Request,
  pathname: string,
  deps: InternalDeps
): Promise<Response | null> {
  const route = routeOf(pathname);
  if (route === null) return null;
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const scope = scopeOf(route);
  const check = await deps.serviceTokens(request.headers.get('Authorization'), scope);
  switch (check.status) {
    case 'missing':
    case 'invalid':
      return jsonResponse({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      });
    case 'insufficient_scope':
      return jsonResponse({ error: 'insufficient_scope' }, 403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}"`,
      });
    case 'unavailable':
      return unavailable(check.retryAfterSeconds);
    case 'verified':
      break;
  }
  const workloads: readonly string[] = UTS_INTERNAL_WORKLOADS;
  if (!workloads.includes(check.workload)) {
    console.warn(JSON.stringify({ event: 'uts.internal.workload_refused', scope }));
    return jsonResponse({ error: 'insufficient_scope' }, 403);
  }
  if (deps.subjects === null) return unavailable(NO_VERIFIER_RETRY_SECONDS);
  const body: unknown = await request.json().catch(() => undefined);
  return await routeResponse(route, body, deps.subjects, check.workload);
}
