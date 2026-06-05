import {
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  validateKiloSdkMessagesCursor,
} from '@kilocode/session-ingest-contracts';
import { DurableObject } from 'cloudflare:workers';
import { TRPCError } from '@trpc/server';
import type {
  GetCloudAgentRootSessionMessagesParams,
  KiloSdkSessionInfo,
  KiloSdkStoredMessage,
  ListCloudAgentRootSessionsParams,
} from '../session-ingest-binding.js';
import {
  fetchOrgIdForSession,
  validateBalanceOnly,
  type BalanceOnlyResult,
} from '../balance-validation.js';
import type {
  QueueExecutionTurnCommand,
  SubmittedSessionMessageRequest,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { UserId } from '../types/ids.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import { preflightAndAdmitPromptMessage } from '../session/queue-message.js';
import { parseBasicKiloPrompt } from './basic-prompt.js';
import {
  isPublicCloudAgentExtensionSourceType,
  type PublicCloudAgentExtensionEvent,
} from './cloud-agent-extension-events.js';
import { createProxyRequest } from '../shared/http-proxy.js';
import { hasDuplicateQueryParameters } from '../shared/http-query.js';
import {
  projectPublicListedSession,
  projectPublicSession,
  projectPublicStoredMessages,
  publicCloudAgentDirectory,
} from './public-sdk-projection.js';
import {
  buildWrapperKiloProxyUrl,
  decideSessionKiloFacadeRoute,
  resolveLiveWrapperTarget,
  type LiveWrapperTarget,
  type SessionKiloFacadeDecision,
  type SessionKiloFacadePolicyInput,
} from './session-proxy.js';

export const KILO_FACADE_USER_ID_HEADER = 'x-kilo-facade-user-id';
export const KILO_FACADE_AUTH_TOKEN_HEADER = 'x-kilo-facade-auth-token';

export const KILO_FACADE_GLOBAL_FEED_PATH = '/internal/kilo/global-feed';
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE = 64;
const SLOW_SUBSCRIBER_ERROR = 'Global event subscriber fell behind';
const SUPPORTED_SESSION_LIST_QUERY_PARAMS = new Set(['limit', 'start']);
const SUPPORTED_SESSION_MESSAGES_QUERY_PARAMS = new Set(['directory', 'limit', 'before']);
const KNOWN_UNSUPPORTED_ROUTES = new Set([
  'GET /session/status',
  'POST /session/viewed',
  'POST /sync/history',
  'GET /config',
  'GET /provider',
  'GET /project/current',
  'GET /global/health',
]);
const MAX_KILO_SESSION_JSON_BYTES = 8 * 1024 * 1024;
const MAX_KILO_ERROR_JSON_BYTES = 64 * 1024;
const MAX_KILO_PROMPT_JSON_BYTES = 256 * 1024;
const MAX_TIMESTAMP_MILLISECONDS = 8_640_000_000_000_000;
const PUBLIC_VIRTUAL_SERVER_DIRECTORY = '/cloud-agent';

type KiloEventPayload = Record<string, unknown> & {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
};

type KiloGlobalEventEnvelope = Record<string, unknown> & {
  directory?: string;
  project?: unknown;
  workspace?: unknown;
  payload?: KiloEventPayload;
};

type GlobalFeedSource = {
  userId: string;
  cloudAgentSessionId: string;
  kiloSessionId: string;
  wrapperRunId: string;
  wrapperGeneration: number;
  wrapperConnectionId: string;
};

type PublicSubscriber = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  scope: { kind: 'global' } | { kind: 'session'; kiloSessionId: string };
};

export type KiloFacadeGlobalEvents = {
  openPublicGlobalEventStream(): Response;
  openPublicSessionEventStream(kiloSessionId: string): Response;
};

export type KiloFacadeRequestDeps = {
  resolveRootSessionForKiloSession?: (params: {
    env: Env;
    userId: string;
    kiloSessionId: string;
  }) => Promise<{ cloudAgentSessionId: string } | null>;
  decideSessionRoute?: (input: SessionKiloFacadePolicyInput) => SessionKiloFacadeDecision;
  resolveLiveWrapper?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<LiveWrapperTarget | null>;
  admitPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
    request: SubmittedSessionMessageRequest;
  }) => Promise<SessionMessageAdmissionResult>;
  validatePromptBalance?: (params: {
    env: Env;
    authToken: string;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<BalanceOnlyResult>;
  interruptPrompt?: (params: {
    env: Env;
    userId: string;
    cloudAgentSessionId: string;
  }) => Promise<Awaited<ReturnType<CloudAgentSession['interruptExecution']>>>;
  globalEvents?: KiloFacadeGlobalEvents;
};

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function facadeError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

function kiloRelativePath(pathname: string): string {
  if (pathname === '/kilo') {
    return '/';
  }
  if (pathname.startsWith('/kilo/')) {
    return pathname.slice('/kilo'.length);
  }
  return pathname;
}

function parseRootSessionRoute(kiloPath: string): {
  encodedKiloSessionId: string;
  kiloSessionId: string;
} | null {
  const match = /^\/session\/([^/]+)(?:\/.*)?$/.exec(kiloPath);
  if (!match?.[1]) {
    return null;
  }
  try {
    return {
      encodedKiloSessionId: match[1],
      kiloSessionId: decodeURIComponent(match[1]),
    };
  } catch {
    return null;
  }
}

function isSessionIngestKiloSessionId(kiloSessionId: string): boolean {
  return kiloSessionId.startsWith('ses_') && kiloSessionId.length === 30;
}

function missingRootKiloSessionResponse(): Response {
  return facadeError(404, 'KILO_SESSION_NOT_FOUND', 'Cloud Agent root Kilo session was not found');
}

function pendingSessionSnapshotResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_SNAPSHOT_PENDING',
    'Cloud Agent Kilo session snapshot is not available yet'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

function sessionSnapshotTooLargeResponse(): Response {
  return facadeError(
    413,
    'KILO_SESSION_SNAPSHOT_TOO_LARGE',
    'Persisted Kilo session snapshot exceeds the safe cold-read budget'
  );
}

function retryableSessionReadResponse(): Response {
  const response = facadeError(
    503,
    'KILO_SESSION_READ_RETRYABLE',
    'Persisted Kilo session data is temporarily unavailable; retry the request'
  );
  response.headers.set('Retry-After', '1');
  return response;
}

function invalidPersistedSessionDataResponse(entity: 'session' | 'messages'): Response {
  return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', `Kilo ${entity} response is not valid`);
}

function transcriptTooLargeResponse(): Response {
  return facadeError(
    413,
    'KILO_TRANSCRIPT_TOO_LARGE',
    'Persisted Kilo transcript exceeds the safe cold-read budget; use smaller bounded history when possible, or retry while a live runtime is available'
  );
}

function isKiloEventPayload(value: unknown): value is KiloEventPayload {
  return isRecord(value) && typeof value.type === 'string' && isRecord(value.properties);
}

function isKiloGlobalEventEnvelope(value: unknown): value is KiloGlobalEventEnvelope {
  return isRecord(value) && isKiloEventPayload(value.payload);
}

function isSubstantiveKiloGlobalEventEnvelope(
  value: unknown
): value is KiloGlobalEventEnvelope & { directory: string; payload: KiloEventPayload } {
  return (
    isKiloGlobalEventEnvelope(value) &&
    typeof value.directory === 'string' &&
    value.directory.length > 0
  );
}

function createPublicEventPayload(type: 'server.connected'): KiloEventPayload {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type,
    properties: {},
  };
}

export { publicCloudAgentDirectory };

function isKiloSdkSessionInfo(value: unknown, kiloSessionId: string): value is KiloSdkSessionInfo {
  return (
    isRecord(value) &&
    value.id === kiloSessionId &&
    typeof value.slug === 'string' &&
    typeof value.projectID === 'string' &&
    typeof value.directory === 'string' &&
    typeof value.title === 'string' &&
    typeof value.version === 'string' &&
    isRecord(value.time) &&
    typeof value.time.created === 'number' &&
    typeof value.time.updated === 'number'
  );
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array | null> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    if (byteLength + value.byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function isUnavailableKiloRuntimeResponse(response: Response): Promise<boolean> {
  if (response.status !== 502 && response.status !== 503) {
    return false;
  }
  const contentType = response.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('application/json')) {
    return false;
  }
  const bytes = await readBoundedBody(response.clone(), MAX_KILO_ERROR_JSON_BYTES);
  if (!bytes) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return (
      isRecord(parsed) &&
      (parsed.error === 'KILO_RUNTIME_UNAVAILABLE' || parsed.error === 'KILO_PROXY_ERROR')
    );
  } catch {
    return false;
  }
}

async function parseLiveSessionDetail(
  response: Response,
  kiloSessionId: string
): Promise<KiloSdkSessionInfo | Response> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_SESSION_JSON_BYTES) {
      return facadeError(
        502,
        'KILO_UPSTREAM_RESPONSE_INVALID',
        'Kilo session response exceeds supported size'
      );
    }
  }

  const bytes = await readBoundedBody(response, MAX_KILO_SESSION_JSON_BYTES);
  if (!bytes) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo session response exceeds supported size'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo session response is not valid JSON'
    );
  }
  if (!isKiloSdkSessionInfo(parsed, kiloSessionId)) {
    return facadeError(502, 'KILO_UPSTREAM_RESPONSE_INVALID', 'Kilo session response is not valid');
  }
  return parsed;
}

async function rewriteLiveSessionDetailResponse(
  response: Response,
  kiloSessionId: string
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const info = await parseLiveSessionDetail(response, kiloSessionId);
  if (info instanceof Response) {
    return info;
  }
  const publicInfo = projectPublicSession(info, kiloSessionId);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(publicInfo), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isKiloSdkMessageInfo(value: unknown, kiloSessionId: string): boolean {
  if (!isRecord(value) || value.sessionID !== kiloSessionId || typeof value.id !== 'string') {
    return false;
  }
  if (value.role === 'user') return true;
  return (
    value.role === 'assistant' &&
    isRecord(value.path) &&
    typeof value.path.cwd === 'string' &&
    typeof value.path.root === 'string'
  );
}

function isKiloSdkPart(value: unknown, kiloSessionId: string): boolean {
  if (
    !isRecord(value) ||
    value.sessionID !== kiloSessionId ||
    typeof value.messageID !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string'
  ) {
    return false;
  }
  if (value.type === 'file' && value.source !== undefined) {
    return (
      isRecord(value.source) &&
      (value.source.type === 'resource' || typeof value.source.path === 'string')
    );
  }
  if (value.type === 'tool' && isRecord(value.state) && Array.isArray(value.state.attachments)) {
    return value.state.attachments.every(part => isKiloSdkPart(part, kiloSessionId));
  }
  return true;
}

function isKiloSdkStoredMessage(
  value: unknown,
  kiloSessionId: string
): value is KiloSdkStoredMessage {
  return (
    isRecord(value) &&
    isKiloSdkMessageInfo(value.info, kiloSessionId) &&
    Array.isArray(value.parts) &&
    value.parts.every(part => isKiloSdkPart(part, kiloSessionId))
  );
}

async function rewriteLiveMessagesResponse(
  response: Response,
  kiloSessionId: string
): Promise<Response> {
  if (!response.ok) return response;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_SESSION_JSON_BYTES) {
      return facadeError(
        502,
        'KILO_UPSTREAM_RESPONSE_INVALID',
        'Kilo messages response exceeds supported size'
      );
    }
  }
  const bytes = await readBoundedBody(response, MAX_KILO_SESSION_JSON_BYTES);
  if (!bytes) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response exceeds supported size'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response is not valid JSON'
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(message => isKiloSdkStoredMessage(message, kiloSessionId))
  ) {
    return facadeError(
      502,
      'KILO_UPSTREAM_RESPONSE_INVALID',
      'Kilo messages response is not valid'
    );
  }
  const publicMessages = projectPublicStoredMessages(parsed, kiloSessionId);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(publicMessages), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function duplicateQueryParametersResponse(): Response {
  return facadeError(400, 'KILO_QUERY_INVALID', 'Query parameters must be unique');
}

function parseSessionListQuery(
  url: URL
): Omit<ListCloudAgentRootSessionsParams, 'kiloUserId'> | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_SESSION_LIST_QUERY_PARAMS.has(key)) {
      return facadeError(
        400,
        'KILO_SESSION_LIST_SELECTOR_UNSUPPORTED',
        `Session list query parameter is not supported: ${key}`
      );
    }
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }

  const params: Omit<ListCloudAgentRootSessionsParams, 'kiloUserId'> = {};
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session list limit must be an integer from 1 to 100'
      );
    }
    params.limit = limit;
  }
  const startParam = url.searchParams.get('start');
  if (startParam !== null) {
    const start = Number(startParam);
    if (!Number.isSafeInteger(start) || start < 0 || start > MAX_TIMESTAMP_MILLISECONDS) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session list start must be a non-negative integer'
      );
    }
    params.start = start;
  }
  return params;
}

function unsupportedSessionSelectorResponse(): Response {
  return facadeError(
    400,
    'KILO_SESSION_SELECTOR_UNSUPPORTED',
    'Only the matching public Cloud Agent session directory selector is supported'
  );
}

function validateIdScopedSelectors(
  url: URL,
  kiloSessionId: string,
  paginationKeys: Set<string>
): Response | null {
  for (const key of url.searchParams.keys()) {
    if (paginationKeys.has(key)) continue;
    if (key !== 'directory') return unsupportedSessionSelectorResponse();
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = url.searchParams.get('directory');
  if (directory !== null && directory !== publicCloudAgentDirectory(kiloSessionId)) {
    return unsupportedSessionSelectorResponse();
  }
  return null;
}

function parseSessionMessagesQuery(
  url: URL
): Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> | Response {
  for (const key of url.searchParams.keys()) {
    if (!SUPPORTED_SESSION_MESSAGES_QUERY_PARAMS.has(key)) {
      return unsupportedSessionSelectorResponse();
    }
  }
  const params: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'> = {};
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    const limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        `Session messages limit must be an integer from 0 to ${MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE}`
      );
    }
    params.limit = limit;
  }
  const before = url.searchParams.get('before');
  if (before !== null) {
    if (before.length === 0 || params.limit === undefined || params.limit === 0) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before requires a positive limit'
      );
    }
    if (!validateKiloSdkMessagesCursor(before)) {
      return facadeError(
        400,
        'KILO_QUERY_INVALID',
        'Session messages before is not a valid cursor'
      );
    }
    params.before = before;
  }
  return params;
}

function isExactSessionDetailRead(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'GET' && kiloPath === `/session/${routePath}`;
}

function isExactSessionMessagesRead(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'GET' && kiloPath === `/session/${routePath}/message`;
}

function isExactSessionPromptAsync(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'POST' && kiloPath === `/session/${routePath}/prompt_async`;
}

function isExactSessionAbort(method: string, kiloPath: string, routePath: string): boolean {
  return method === 'POST' && kiloPath === `/session/${routePath}/abort`;
}

function promptAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): Response {
  switch (result.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', result.error);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'PENDING_QUEUE_FULL':
      return facadeError(429, 'KILO_PROMPT_QUEUE_FULL', result.error);
    case 'SANDBOX_CONNECT_FAILED':
    case 'WORKSPACE_SETUP_FAILED':
    case 'KILO_SERVER_FAILED':
    case 'WRAPPER_START_FAILED':
      return facadeError(503, result.code, result.error);
    case 'INTERNAL':
      return facadeError(500, 'KILO_PROMPT_ADMISSION_FAILED', result.error);
  }
}

function promptPreflightError(error: unknown): Response {
  if (!(error instanceof TRPCError)) throw error;
  switch (error.code) {
    case 'BAD_REQUEST':
      return facadeError(400, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'NOT_FOUND':
      return missingRootKiloSessionResponse();
    case 'FORBIDDEN':
      return facadeError(403, 'KILO_PROMPT_ADMISSION_REJECTED', error.message);
    case 'SERVICE_UNAVAILABLE':
      return facadeError(503, 'MODEL_VALIDATION_UNAVAILABLE', error.message);
    default:
      throw error;
  }
}

type ReadRequestJsonResult =
  | { success: true; value: unknown }
  | { success: false; response: Response };

async function readRequestJson(request: Request): Promise<ReadRequestJsonResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const bodyBytes = Number(declaredLength);
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > MAX_KILO_PROMPT_JSON_BYTES) {
      return {
        success: false,
        response: facadeError(
          400,
          'KILO_BASIC_PROMPT_UNSUPPORTED',
          'Basic Kilo prompt body is not supported'
        ),
      };
    }
  }
  const response = new Response(request.body);
  const bytes = await readBoundedBody(response, MAX_KILO_PROMPT_JSON_BYTES);
  if (!bytes) {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
  try {
    return { success: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      success: false,
      response: facadeError(
        400,
        'KILO_BASIC_PROMPT_UNSUPPORTED',
        'Basic Kilo prompt body is not supported'
      ),
    };
  }
}

async function defaultValidatePromptBalance(params: {
  env: Env;
  authToken: string;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<BalanceOnlyResult> {
  const orgId = await fetchOrgIdForSession(params.env, params.userId, params.cloudAgentSessionId);
  return validateBalanceOnly(params.authToken, orgId, params.env);
}

async function defaultAdmitPrompt(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  request: SubmittedSessionMessageRequest;
}): Promise<SessionMessageAdmissionResult> {
  const id = params.env.CLOUD_AGENT_SESSION.idFromName(
    `${params.userId}:${params.cloudAgentSessionId}`
  );
  return withDORetry<DurableObjectStub<CloudAgentSession>, SessionMessageAdmissionResult>(
    () => params.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.admitSubmittedMessage(params.request),
    'admitSubmittedMessage'
  );
}

async function admitBasicPrompt(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<SessionMessageAdmissionResult | Response> {
  const body = await readRequestJson(params.request);
  if (!body.success) {
    return body.response;
  }
  const parsed = parseBasicKiloPrompt(body.value);
  if (!parsed.success) {
    return facadeError(
      400,
      'KILO_BASIC_PROMPT_UNSUPPORTED',
      'Basic Kilo prompt body is not supported'
    );
  }
  if (!params.authToken) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Durable prompt admission is unavailable');
  }
  if (params.request.headers.get('x-skip-balance-check') !== null) {
    return facadeError(
      400,
      'KILO_BALANCE_BYPASS_UNSUPPORTED',
      'Balance bypass is not supported for public Kilo prompt mutations'
    );
  }
  const balance = await (params.deps?.validatePromptBalance ?? defaultValidatePromptBalance)({
    env: params.env,
    authToken: params.authToken,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
  });
  if (!balance.success) {
    return facadeError(balance.status, 'KILO_BALANCE_VALIDATION_FAILED', balance.message);
  }
  const command = {
    turn: {
      type: 'prompt',
      id: parsed.prompt.messageId,
      prompt: parsed.prompt.prompt,
    },
    ...(parsed.prompt.agent ? { agent: parsed.prompt.agent } : {}),
  } satisfies QueueExecutionTurnCommand;
  const request: SubmittedSessionMessageRequest = {
    userId: params.userId as UserId,
    ...command,
  };
  const admitPrompt = params.deps?.admitPrompt ?? defaultAdmitPrompt;
  try {
    return await preflightAndAdmitPromptMessage(
      { cloudAgentSessionId: params.cloudAgentSessionId, ...command },
      { env: params.env, userId: params.userId },
      'kilo.prompt_async',
      () =>
        admitPrompt({
          env: params.env,
          userId: params.userId,
          cloudAgentSessionId: params.cloudAgentSessionId,
          request,
        })
    );
  } catch (error) {
    return promptPreflightError(error);
  }
}

async function handlePromptAsyncMutation(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  const admission = await admitBasicPrompt(params);
  if (admission instanceof Response) {
    return admission;
  }
  if (!admission.success) {
    return promptAdmissionError(admission);
  }
  return new Response(null, { status: 204 });
}

async function defaultInterruptPrompt(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<Awaited<ReturnType<CloudAgentSession['interruptExecution']>>> {
  const id = params.env.CLOUD_AGENT_SESSION.idFromName(
    `${params.userId}:${params.cloudAgentSessionId}`
  );
  return withDORetry<
    DurableObjectStub<CloudAgentSession>,
    Awaited<ReturnType<CloudAgentSession['interruptExecution']>>
  >(
    () => params.env.CLOUD_AGENT_SESSION.get(id),
    stub => stub.interruptExecution(),
    'interruptExecution'
  );
}

async function handleAbortMutation(params: {
  env: Env;
  userId: string;
  cloudAgentSessionId: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  await (params.deps?.interruptPrompt ?? defaultInterruptPrompt)({
    env: params.env,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
  });
  return Response.json(true);
}

function messagesPageResponse(
  requestUrl: URL,
  messages: unknown,
  nextCursor: string | null,
  omittedItemCount: number
): Response {
  const headers = new Headers({
    'content-type': 'application/json',
    'X-Kilo-Omitted-Item-Count': String(omittedItemCount),
  });
  if (nextCursor !== null) {
    const nextUrl = new URL(requestUrl);
    nextUrl.searchParams.set('before', nextCursor);
    headers.set('Link', `<${nextUrl.toString()}>; rel="next"`);
    headers.set('X-Next-Cursor', nextCursor);
  }
  return new Response(JSON.stringify(messages), { headers });
}

async function persistedSessionDetailResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
}): Promise<Response> {
  const snapshot = await params.env.SESSION_INGEST.getCloudAgentRootSessionSnapshot({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
  });
  if (!snapshot) {
    return missingRootKiloSessionResponse();
  }
  switch (snapshot.snapshot.kind) {
    case 'pending':
      return pendingSessionSnapshotResponse();
    case 'too_large':
      return sessionSnapshotTooLargeResponse();
    case 'retryable_failure':
      return retryableSessionReadResponse();
    case 'invalid_data':
      return invalidPersistedSessionDataResponse('session');
    case 'value':
      return Response.json(projectPublicSession(snapshot.snapshot.info, snapshot.kiloSessionId));
  }
}

async function persistedSessionMessagesResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
  url: URL;
  query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>;
}): Promise<Response> {
  const result = await params.env.SESSION_INGEST.getCloudAgentRootSessionMessages({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
    ...params.query,
  });
  if (!result) {
    return missingRootKiloSessionResponse();
  }
  if (result.history === null) {
    return pendingSessionSnapshotResponse();
  }
  if ('kind' in result.history) {
    switch (result.history.kind) {
      case 'too_large':
        return transcriptTooLargeResponse();
      case 'retryable_failure':
        return retryableSessionReadResponse();
      case 'invalid_data':
        return invalidPersistedSessionDataResponse('messages');
    }
  }
  const publicMessages = projectPublicStoredMessages(result.history.messages, params.kiloSessionId);
  return messagesPageResponse(
    params.url,
    publicMessages,
    result.history.nextCursor,
    result.history.omittedItemCount ?? 0
  );
}

type PersistedSessionRead =
  | { kind: 'detail' }
  | {
      kind: 'messages';
      query: Pick<GetCloudAgentRootSessionMessagesParams, 'limit' | 'before'>;
    };

function persistedSessionReadResponse(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
  url: URL;
  read: PersistedSessionRead;
}): Promise<Response> {
  switch (params.read.kind) {
    case 'detail':
      return persistedSessionDetailResponse(params);
    case 'messages':
      return persistedSessionMessagesResponse({ ...params, query: params.read.query });
  }
}

export function isSyntheticGlobalEvent(event: KiloGlobalEventEnvelope): boolean {
  const type = event.payload?.type;
  return type === 'server.connected' || type === 'server.heartbeat';
}

function parsePublicSessionDirectory(directory: string): string | null {
  const match = /^\/cloud-agent\/sessions\/([^/]+)$/.exec(directory);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function rewriteGlobalEventDirectory(
  event: KiloGlobalEventEnvelope,
  kiloSessionId: string
): KiloGlobalEventEnvelope {
  return {
    ...event,
    directory: publicCloudAgentDirectory(kiloSessionId),
  };
}

export function encodeSseData(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function encodeSseComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export async function defaultResolveRootSessionForKiloSession(params: {
  env: Env;
  userId: string;
  kiloSessionId: string;
}): Promise<{ cloudAgentSessionId: string } | null> {
  return params.env.SESSION_INGEST.resolveCloudAgentRootSessionForKiloSession({
    kiloUserId: params.userId,
    kiloSessionId: params.kiloSessionId,
  });
}

async function eventStreamResponse(params: {
  request: Request;
  env: Env;
  userId: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  kiloPath: string;
}): Promise<Response | null> {
  const { request, env, userId, deps, url, kiloPath } = params;
  if (kiloPath === '/global/event') {
    if (request.method !== 'GET') {
      return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
    }
    if (url.search.length > 0) {
      return facadeError(
        400,
        'KILO_EVENT_SELECTOR_UNSUPPORTED',
        'Global event selectors are not supported'
      );
    }
    const globalEvents = deps?.globalEvents;
    if (!globalEvents) {
      return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
    }
    return globalEvents.openPublicGlobalEventStream();
  }

  if (kiloPath !== '/event') {
    return null;
  }
  if (request.method !== 'GET') {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }
  if ([...url.searchParams.keys()].some(key => key !== 'directory')) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Only the Cloud Agent session directory selector is supported'
    );
  }
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return duplicateQueryParametersResponse();
  }
  const directory = url.searchParams.get('directory');
  if (!directory) {
    return facadeError(
      400,
      'KILO_EVENT_DIRECTORY_REQUIRED',
      'A Cloud Agent session directory selector is required'
    );
  }
  const kiloSessionId = parsePublicSessionDirectory(directory);
  if (!kiloSessionId) {
    return facadeError(
      400,
      'KILO_EVENT_SELECTOR_UNSUPPORTED',
      'Only a Cloud Agent root session directory selector is supported'
    );
  }
  if (!isSessionIngestKiloSessionId(kiloSessionId)) {
    return missingRootKiloSessionResponse();
  }
  const resolveRoot =
    deps?.resolveRootSessionForKiloSession ?? defaultResolveRootSessionForKiloSession;
  const root = await resolveRoot({ env, userId, kiloSessionId });
  if (!root) {
    return missingRootKiloSessionResponse();
  }
  const globalEvents = deps?.globalEvents;
  if (!globalEvents) {
    return facadeError(500, 'KILO_FACADE_UNAVAILABLE', 'Kilo facade stream is unavailable');
  }
  return globalEvents.openPublicSessionEventStream(kiloSessionId);
}

async function proxyOwnedKiloSessionRequest(params: {
  request: Request;
  env: Env;
  userId: string;
  deps?: KiloFacadeRequestDeps;
  url: URL;
  kiloPath: string;
  kiloSessionId: string;
  cloudAgentSessionId: string;
  persistedRead: PersistedSessionRead | null;
}): Promise<Response> {
  const { request, env, userId, deps, url, kiloPath, kiloSessionId, cloudAgentSessionId } = params;
  const persistedFallback = () =>
    params.persistedRead
      ? persistedSessionReadResponse({
          env,
          userId,
          kiloSessionId,
          url,
          read: params.persistedRead,
        })
      : null;

  let liveWrapper: LiveWrapperTarget | null;
  try {
    liveWrapper = await (deps?.resolveLiveWrapper ?? resolveLiveWrapperTarget)({
      env,
      userId,
      cloudAgentSessionId,
    });
  } catch (error) {
    const fallback = persistedFallback();
    if (fallback) return fallback;
    throw error;
  }
  if (!liveWrapper) {
    const fallback = persistedFallback();
    if (fallback) return fallback;
    return facadeError(
      503,
      'KILO_LIVE_RUNTIME_UNAVAILABLE',
      'Cloud Agent Kilo runtime is not live'
    );
  }

  const upstreamSearchParams = new URLSearchParams(url.searchParams);
  upstreamSearchParams.delete('directory');
  const upstreamSearch = upstreamSearchParams.size > 0 ? `?${upstreamSearchParams.toString()}` : '';
  const targetUrl = buildWrapperKiloProxyUrl({
    wrapperPort: liveWrapper.port,
    kiloRelativePath: kiloPath,
    search: upstreamSearch,
  });
  const proxyRequest = createProxyRequest(request, targetUrl);
  let response: Response;
  try {
    response = await liveWrapper.sandbox.containerFetch(proxyRequest, liveWrapper.port);
  } catch (error) {
    const fallback = persistedFallback();
    if (fallback) return fallback;
    throw error;
  }

  if (!params.persistedRead) {
    return response;
  }
  if (await isUnavailableKiloRuntimeResponse(response)) {
    return persistedSessionReadResponse({
      env,
      userId,
      kiloSessionId,
      url,
      read: params.persistedRead,
    });
  }
  switch (params.persistedRead.kind) {
    case 'detail':
      return rewriteLiveSessionDetailResponse(response, kiloSessionId);
    case 'messages':
      return rewriteLiveMessagesResponse(response, kiloSessionId);
  }
}

export async function handleKiloFacadeRequest(params: {
  request: Request;
  env: Env;
  userId: string;
  authToken?: string;
  deps?: KiloFacadeRequestDeps;
}): Promise<Response> {
  const { request, env, userId, authToken, deps } = params;
  const url = new URL(request.url);
  const kiloPath = kiloRelativePath(url.pathname);

  const streamResponse = await eventStreamResponse({ request, env, userId, deps, url, kiloPath });
  if (streamResponse) {
    return streamResponse;
  }

  if (kiloPath === '/session' && request.method === 'GET') {
    const query = parseSessionListQuery(url);
    if (query instanceof Response) {
      return query;
    }
    const sessions = await env.SESSION_INGEST.listCloudAgentRootSessions({
      ...query,
      kiloUserId: userId,
    });
    return Response.json(sessions.map(projectPublicListedSession));
  }

  if (kiloPath === '/session' || KNOWN_UNSUPPORTED_ROUTES.has(`${request.method} ${kiloPath}`)) {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }

  const route = parseRootSessionRoute(kiloPath);
  if (!route) {
    return facadeError(501, 'KILO_ROUTE_UNSUPPORTED', 'Kilo facade route is not supported');
  }
  if (!isSessionIngestKiloSessionId(route.kiloSessionId)) {
    return missingRootKiloSessionResponse();
  }

  const resolveRoot =
    deps?.resolveRootSessionForKiloSession ?? defaultResolveRootSessionForKiloSession;
  const root = await resolveRoot({ env, userId, kiloSessionId: route.kiloSessionId });
  if (!root) {
    return missingRootKiloSessionResponse();
  }

  const policyInput: SessionKiloFacadePolicyInput = {
    method: request.method,
    kiloRelativePath: kiloPath,
    search: url.search,
    userId,
    kiloSessionId: route.kiloSessionId,
    cloudAgentSessionId: root.cloudAgentSessionId,
  };
  const decision = (deps?.decideSessionRoute ?? decideSessionKiloFacadeRoute)(policyInput);
  if (decision.kind === 'reject') {
    return facadeError(decision.status, decision.code, decision.message);
  }

  const routeClassification = {
    detailRead: isExactSessionDetailRead(request.method, kiloPath, route.encodedKiloSessionId),
    messagesRead: isExactSessionMessagesRead(request.method, kiloPath, route.encodedKiloSessionId),
    promptAsync: isExactSessionPromptAsync(request.method, kiloPath, route.encodedKiloSessionId),
    abort: isExactSessionAbort(request.method, kiloPath, route.encodedKiloSessionId),
  };
  if (
    routeClassification.detailRead ||
    routeClassification.messagesRead ||
    routeClassification.promptAsync ||
    routeClassification.abort
  ) {
    const paginationKeys = routeClassification.messagesRead
      ? new Set(['limit', 'before'])
      : new Set<string>();
    const selectorResponse = validateIdScopedSelectors(url, route.kiloSessionId, paginationKeys);
    if (selectorResponse) return selectorResponse;
  }

  if (routeClassification.promptAsync) {
    return handlePromptAsyncMutation({
      request,
      env,
      userId,
      authToken,
      cloudAgentSessionId: root.cloudAgentSessionId,
      deps,
    });
  }
  if (routeClassification.abort) {
    return handleAbortMutation({
      env,
      userId,
      cloudAgentSessionId: root.cloudAgentSessionId,
      deps,
    });
  }

  const messageQuery = routeClassification.messagesRead ? parseSessionMessagesQuery(url) : null;
  if (messageQuery instanceof Response) {
    return messageQuery;
  }
  const persistedRead: PersistedSessionRead | null = routeClassification.detailRead
    ? { kind: 'detail' }
    : routeClassification.messagesRead && messageQuery !== null
      ? { kind: 'messages', query: messageQuery }
      : null;
  return proxyOwnedKiloSessionRequest({
    request,
    env,
    userId,
    deps,
    url,
    kiloPath,
    kiloSessionId: route.kiloSessionId,
    cloudAgentSessionId: root.cloudAgentSessionId,
    persistedRead,
  });
}

function parseGlobalFeedSource(request: Request): GlobalFeedSource | Response {
  const url = new URL(request.url);
  if (hasDuplicateQueryParameters(url.searchParams)) {
    return facadeError(400, 'INVALID_GLOBAL_FEED_SOURCE', 'Invalid global feed source');
  }
  const userId = url.searchParams.get('userId');
  const cloudAgentSessionId = url.searchParams.get('cloudAgentSessionId');
  const kiloSessionId = url.searchParams.get('kiloSessionId');
  const wrapperRunId = url.searchParams.get('wrapperRunId');
  const wrapperGenerationParam = url.searchParams.get('wrapperGeneration');
  const wrapperConnectionId = url.searchParams.get('wrapperConnectionId');
  const wrapperGeneration = wrapperGenerationParam ? Number(wrapperGenerationParam) : NaN;

  if (
    !userId ||
    !cloudAgentSessionId ||
    !kiloSessionId ||
    !wrapperRunId ||
    !Number.isInteger(wrapperGeneration) ||
    wrapperGeneration < 0 ||
    !wrapperConnectionId
  ) {
    return facadeError(400, 'INVALID_GLOBAL_FEED_SOURCE', 'Invalid global feed source');
  }

  return {
    userId,
    cloudAgentSessionId,
    kiloSessionId,
    wrapperRunId,
    wrapperGeneration,
    wrapperConnectionId,
  };
}

function producerTag(source: Pick<GlobalFeedSource, 'cloudAgentSessionId'>): string {
  return `kilo-global:${source.cloudAgentSessionId}`;
}

function isSameGlobalFeedProducer(left: GlobalFeedSource, right: GlobalFeedSource): boolean {
  return (
    left.wrapperRunId === right.wrapperRunId &&
    left.wrapperGeneration === right.wrapperGeneration &&
    left.wrapperConnectionId === right.wrapperConnectionId
  );
}

function mayReplaceGlobalFeedProducer(
  existing: GlobalFeedSource,
  candidate: GlobalFeedSource
): boolean {
  if (candidate.wrapperGeneration > existing.wrapperGeneration) return true;
  if (candidate.wrapperGeneration < existing.wrapperGeneration) return false;
  return isSameGlobalFeedProducer(existing, candidate);
}

export class UserKiloFacade extends DurableObject<Env> implements KiloFacadeGlobalEvents {
  private subscribers = new Map<string, PublicSubscriber>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === KILO_FACADE_GLOBAL_FEED_PATH) {
      return this.handleGlobalFeedRequest(request);
    }

    const userId = request.headers.get(KILO_FACADE_USER_ID_HEADER);
    if (!userId) {
      return facadeError(401, 'UNAUTHENTICATED', 'Missing authenticated user context');
    }
    const authToken = request.headers.get(KILO_FACADE_AUTH_TOKEN_HEADER) ?? undefined;

    return handleKiloFacadeRequest({
      request,
      env: this.env,
      userId,
      authToken,
      deps: { globalEvents: this },
    });
  }

  openPublicGlobalEventStream(): Response {
    return this.openPublicEventStream({ kind: 'global' });
  }

  openPublicSessionEventStream(kiloSessionId: string): Response {
    return this.openPublicEventStream({ kind: 'session', kiloSessionId });
  }

  async publishCloudAgentExtensionEvent(input: {
    kiloUserId: string;
    cloudAgentSessionId: string;
    kiloSessionId: string;
    organizationId?: string;
    event: PublicCloudAgentExtensionEvent;
  }): Promise<void> {
    if (input.organizationId) {
      const sessionIngest = this.env.SESSION_INGEST;
      if (!sessionIngest) return;
      const resolved = await sessionIngest.resolveCloudAgentRootSessionForKiloSession({
        kiloUserId: input.kiloUserId,
        kiloSessionId: input.kiloSessionId,
      });
      if (resolved?.cloudAgentSessionId !== input.cloudAgentSessionId) return;
    }
    this.broadcastGlobalEvent(
      { directory: publicCloudAgentDirectory(input.kiloSessionId), payload: input.event },
      input.kiloSessionId
    );
  }

  private openPublicEventStream(scope: PublicSubscriber['scope']): Response {
    const subscriberId = crypto.randomUUID();
    const publicConnectionEvent = () =>
      scope.kind === 'global'
        ? {
            directory: PUBLIC_VIRTUAL_SERVER_DIRECTORY,
            payload: createPublicEventPayload('server.connected'),
          }
        : createPublicEventPayload('server.connected');

    const stream = new ReadableStream<Uint8Array>(
      {
        start: controller => {
          const subscriber: PublicSubscriber = {
            controller,
            scope,
            heartbeat: setInterval(() => {
              this.sendCommentToSubscriber(subscriberId, 'heartbeat');
            }, HEARTBEAT_INTERVAL_MS),
          };
          this.subscribers.set(subscriberId, subscriber);
          this.sendToSubscriber(subscriberId, publicConnectionEvent());
        },
        cancel: () => {
          this.removeSubscriber(subscriberId);
        },
      },
      { highWaterMark: MAX_PUBLIC_GLOBAL_EVENT_QUEUE_SIZE, size: () => 1 }
    );

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.handleGlobalFeedMessage(ws, message);
  }

  private validateGlobalFeedProducer(source: GlobalFeedSource) {
    const sessionDoId = this.env.CLOUD_AGENT_SESSION.idFromName(
      `${source.userId}:${source.cloudAgentSessionId}`
    );
    const sessionStub = this.env.CLOUD_AGENT_SESSION.get(sessionDoId);
    return sessionStub.validateKiloGlobalFeedProducer({
      kiloSessionId: source.kiloSessionId,
      wrapperRunId: source.wrapperRunId,
      wrapperGeneration: source.wrapperGeneration,
      wrapperConnectionId: source.wrapperConnectionId,
    });
  }

  private handleGlobalFeedMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      ws.send(JSON.stringify({ error: 'Binary global feed messages are not supported' }));
      return;
    }

    const source = ws.deserializeAttachment() as GlobalFeedSource | null;
    if (!source) {
      ws.close(1011, 'Missing global feed source');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid global feed JSON' }));
      return;
    }

    if (!isKiloGlobalEventEnvelope(parsed)) {
      ws.send(JSON.stringify({ error: 'Invalid global event envelope' }));
      return;
    }

    if (isSyntheticGlobalEvent(parsed)) {
      return;
    }
    if (!isSubstantiveKiloGlobalEventEnvelope(parsed)) {
      ws.send(JSON.stringify({ error: 'Invalid global event envelope' }));
      return;
    }
    if (isPublicCloudAgentExtensionSourceType(parsed.payload.type)) {
      return;
    }

    if (parsed.payload.properties.sessionID !== source.kiloSessionId) {
      return;
    }
    const publicEnvelope = rewriteGlobalEventDirectory(parsed, source.kiloSessionId);
    this.broadcastGlobalEvent(publicEnvelope, source.kiloSessionId);
  }

  webSocketClose(): void {
    // Socket attachments expire with the socket; no persistent cleanup is needed.
  }

  private async handleGlobalFeedRequest(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return facadeError(426, 'WEBSOCKET_REQUIRED', 'Expected WebSocket upgrade');
    }

    const source = parseGlobalFeedSource(request);
    if (source instanceof Response) {
      return source;
    }

    const validation = await this.validateGlobalFeedProducer(source);
    if (!validation.success) {
      return new Response(validation.message, { status: validation.status });
    }

    const tag = producerTag(source);
    const existingSockets = this.ctx.getWebSockets(tag);
    for (const existing of existingSockets) {
      const existingSource = existing.deserializeAttachment() as GlobalFeedSource | null;
      if (existingSource && !mayReplaceGlobalFeedProducer(existingSource, source)) {
        return new Response('A newer global feed producer is already connected', { status: 409 });
      }
    }
    for (const existing of existingSockets) {
      try {
        existing.close(1000, 'Replaced by newer global feed');
      } catch {
        // Ignore already-closed producer sockets.
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment(source);

    return new Response(null, { status: 101, webSocket: client });
  }

  private sendFrameToSubscriber(subscriberId: string, frame: Uint8Array): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    if (subscriber.controller.desiredSize !== null && subscriber.controller.desiredSize <= 0) {
      this.removeSubscriber(subscriberId);
      subscriber.controller.error(new Error(SLOW_SUBSCRIBER_ERROR));
      return;
    }
    try {
      subscriber.controller.enqueue(frame);
    } catch {
      this.removeSubscriber(subscriberId);
    }
  }

  private sendToSubscriber(subscriberId: string, event: unknown): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseData(event));
  }

  private sendCommentToSubscriber(subscriberId: string, comment: string): void {
    this.sendFrameToSubscriber(subscriberId, encodeSseComment(comment));
  }

  private broadcastGlobalEvent(event: KiloGlobalEventEnvelope, kiloSessionId: string): void {
    for (const [subscriberId, subscriber] of this.subscribers.entries()) {
      if (subscriber.scope.kind === 'global') {
        this.sendToSubscriber(subscriberId, event);
        continue;
      }
      if (subscriber.scope.kiloSessionId === kiloSessionId && event.payload) {
        this.sendToSubscriber(subscriberId, event.payload);
      }
    }
  }

  private removeSubscriber(subscriberId: string): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) return;
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriberId);
  }
}
